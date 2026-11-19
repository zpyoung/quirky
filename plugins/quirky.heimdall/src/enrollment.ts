import { randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { checkSchemaDeclaration, validateValue } from '@quirky/protocol'
import type { OwnerConfig } from './contracts'
import type {
  AuthorizedEnrollment,
  BudgetPolicy,
  Enrollment,
  EnrollmentInput,
  EnrollmentResult,
  EnrollmentService,
  HandoffLink,
  HandoffRequest,
  HandoffResult,
  JournalEntry,
  Json,
  KernelOptions,
  StopResult,
  TerminalSummary,
  WatcherKind
} from './contracts'
import { budgetUsage } from './budget'

type RefusalReason = Extract<EnrollmentResult, { kind: 'refused' }>['reason']

class CommitConflict extends Error {
  constructor(readonly reason: RefusalReason, message: string) {
    super(message)
  }
}

class HandoffConflict extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.keys(value).every((key) => isJsonValue((value as Record<string, unknown>)[key], ancestors))
  ancestors.delete(value)
  return valid
}

function isOwnerConfig(value: unknown): value is OwnerConfig | null {
  return value === null || (record(value) && Object.hasOwn(value, 'agent') && value.agent === 'claude' &&
    Object.keys(value).every((key) => key === 'agent' || key === 'model' || key === 'effort') &&
    (!Object.hasOwn(value, 'model') || typeof value.model === 'string') &&
    (!Object.hasOwn(value, 'effort') || typeof value.effort === 'string'))
}

function isCapabilityMode(value: unknown): value is 'off' | 'gated' | 'on' {
  return value === 'off' || value === 'gated' || value === 'on'
}

function normalizeBudget(value: unknown): BudgetPolicy | null {
  if (value === undefined) return { wallClockActiveMs: null, turns: null }
  if (!record(value) || !Object.hasOwn(value, 'wallClockActiveMs') || !Object.hasOwn(value, 'turns') ||
    Object.keys(value).some((key) => key !== 'wallClockActiveMs' && key !== 'turns')) return null
  const wallClockActiveMs = value.wallClockActiveMs
  const turns = value.turns
  if (!(wallClockActiveMs === null || (typeof wallClockActiveMs === 'number' && Number.isFinite(wallClockActiveMs) && wallClockActiveMs >= 0)) ||
    !(turns === null || (typeof turns === 'number' && Number.isFinite(turns) && turns >= 0))) return null
  return { wallClockActiveMs, turns }
}

function normalizeCapabilities(value: unknown): Record<string, 'off' | 'gated' | 'on'> | null {
  if (value === undefined) return {}
  if (!record(value)) return null
  const result: Record<string, 'off' | 'gated' | 'on'> = Object.create(null)
  for (const [name, mode] of Object.entries(value)) {
    if (name.length === 0 || !isCapabilityMode(mode)) return null
    result[name] = mode
  }
  return result
}

function canonicalWorkspacePath(path: string): string {
  if (!isAbsolute(path)) throw new Error('authorized workspacePath must be absolute')
  const normalized = resolve(path)
  let existing = normalized
  const missing: string[] = []
  while (true) {
    try {
      let canonical = realpathSync.native(existing)
      for (let i = missing.length - 1; i >= 0; i--) canonical = join(canonical, missing[i])
      return canonical
    } catch (error) {
      const code = record(error) ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(existing)
      if (parent === existing) return normalized
      missing.push(basename(existing))
      existing = parent
    }
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type EnrollmentSettings = {
  input: EnrollmentInput
  budget: BudgetPolicy
  capabilities: Record<string, 'off' | 'gated' | 'on'>
  owner: OwnerConfig | null
  ownerInterventionCapability?: 'off' | 'gated' | 'on'
}

function enrollmentSettings(value: unknown): EnrollmentSettings | null {
  if (!record(value) || !isJsonValue(value) || !Object.hasOwn(value, 'kind') ||
    typeof value.kind !== 'string' || value.kind.length === 0 || !Object.hasOwn(value, 'kindPayload')) return null
  const budget = normalizeBudget(Object.hasOwn(value, 'budget') ? value.budget : undefined)
  const capabilities = normalizeCapabilities(Object.hasOwn(value, 'capabilities') ? value.capabilities : undefined)
  const requestedOwner: unknown = Object.hasOwn(value, 'owner') ? value.owner : null
  const requestedIntervention = Object.hasOwn(value, 'ownerInterventionCapability')
    ? value.ownerInterventionCapability
    : undefined
  if (!budget || !capabilities || !isOwnerConfig(requestedOwner) ||
    (requestedIntervention !== undefined && !isCapabilityMode(requestedIntervention))) return null
  const owner: OwnerConfig | null = requestedOwner === null ? null : {
    agent: 'claude',
    ...(Object.hasOwn(requestedOwner, 'model') && typeof requestedOwner.model === 'string'
      ? { model: requestedOwner.model }
      : {}),
    ...(Object.hasOwn(requestedOwner, 'effort') && typeof requestedOwner.effort === 'string'
      ? { effort: requestedOwner.effort }
      : {})
  }
  const ownerInterventionCapability = owner !== null
    ? isCapabilityMode(requestedIntervention) ? requestedIntervention : 'off'
    : undefined
  return {
    input: {
      kind: value.kind,
      kindPayload: JSON.parse(JSON.stringify(value.kindPayload)) as Json,
      capabilities: { ...capabilities },
      budget: { ...budget },
      owner: owner === null ? null : { ...owner },
      ...(ownerInterventionCapability !== undefined ? { ownerInterventionCapability } : {})
    },
    budget,
    capabilities,
    owner,
    ...(ownerInterventionCapability !== undefined ? { ownerInterventionCapability } : {})
  }
}

function normalizeAuthorization(
  value: unknown,
  settings: EnrollmentSettings
): AuthorizedEnrollment | null {
  if (!record(value) || !isJsonValue(value) ||
    !Object.hasOwn(value, 'workspaceKey') || typeof value.workspaceKey !== 'string' ||
    !Object.hasOwn(value, 'workspacePath') || typeof value.workspacePath !== 'string' ||
    !Object.hasOwn(value, 'executionHostId') || typeof value.executionHostId !== 'string' ||
    value.executionHostId.length === 0 || !Object.hasOwn(value, 'schedulerOwner') ||
    typeof value.schedulerOwner !== 'string' || value.schedulerOwner.length === 0 ||
    !Object.hasOwn(value, 'kindPayload') || !isJsonValue(value.kindPayload) ||
    (Object.hasOwn(value, 'repoId') && value.repoId !== null && typeof value.repoId !== 'string') ||
    (Object.hasOwn(value, 'worktreeId') && value.worktreeId !== null && typeof value.worktreeId !== 'string') ||
    (Object.hasOwn(value, 'undo') && !isJsonValue(value.undo))) return null
  const canonicalPath = canonicalWorkspacePath(value.workspacePath)
  const result: AuthorizedEnrollment = {
    workspaceKey: `${value.executionHostId}::${canonicalPath}`,
    workspacePath: canonicalPath,
    executionHostId: value.executionHostId,
    schedulerOwner: value.schedulerOwner,
    kindPayload: JSON.parse(JSON.stringify(value.kindPayload)) as Json,
    owner: settings.owner
  }
  if (Object.hasOwn(value, 'repoId')) result.repoId = value.repoId as string | null
  if (Object.hasOwn(value, 'worktreeId')) result.worktreeId = value.worktreeId as string | null
  if (Object.hasOwn(value, 'undo')) result.undo = JSON.parse(JSON.stringify(value.undo)) as Json
  if (settings.ownerInterventionCapability !== undefined) {
    result.ownerInterventionCapability = settings.ownerInterventionCapability
  }
  return result
}

function payloadProblem(kind: WatcherKind, payload: Json): string | null {
  const schemaProblems = checkSchemaDeclaration(kind.enrollmentPayloadSchema, `kind ${kind.id} enrollmentPayloadSchema`)
  if (schemaProblems.length > 0) return schemaProblems.join('; ')
  return validateValue(kind.enrollmentPayloadSchema, payload, 'kindPayload')
}

function addAllowance(spent: number, allowance: number | null): number | null | undefined {
  if (allowance === null) return null
  const result = spent + allowance
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

export function createEnrollmentService(
  options: KernelOptions,
  onEnrolled: (enrollment: Enrollment) => void
): EnrollmentService {
  const executionHostId = options.executionHostId ?? 'local'
  const schedulerOwner = options.schedulerOwner ?? 'daemon'
  const now = options.now ?? Date.now
  let mutationTail = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  const refused = (reason: RefusalReason, detail: string): EnrollmentResult => ({
    kind: 'refused',
    reason,
    detail
  })

  const undoRefusal = async (
    kind: WatcherKind,
    authorization: unknown,
    reason: RefusalReason,
    detail: string
  ): Promise<EnrollmentResult> => {
    try {
      if (kind.undoAuthorization) {
        // Preserve the exact successful authorization result for the owning hook to undo.
        await kind.undoAuthorization(authorization as AuthorizedEnrollment)
      }
    } catch (error) {
      detail += `; authorization undo failed: ${errorDetail(error)}`
    }
    return refused(reason, detail)
  }

  const finishAuthorized = async (
    kind: WatcherKind,
    settings: EnrollmentSettings,
    authorization: unknown
  ): Promise<EnrollmentResult> => {
    let normalizedCandidate: AuthorizedEnrollment | null
    try {
      normalizedCandidate = normalizeAuthorization(authorization, settings)
    } catch (error) {
      return undoRefusal(kind, authorization, 'invalid-payload', `invalid authorized workspace path: ${errorDetail(error)}`)
    }
    if (!normalizedCandidate) {
      return undoRefusal(kind, authorization, 'invalid-payload', 'authorization returned invalid workspace authority or payload')
    }
    const candidate = normalizedCandidate
    if (candidate.executionHostId !== executionHostId || candidate.schedulerOwner !== schedulerOwner) {
      return undoRefusal(kind, authorization, 'owner-not-executable',
        `authorized owner ${candidate.executionHostId}/${candidate.schedulerOwner} does not match local ${executionHostId}/${schedulerOwner}`)
    }
    let payloadFailure: string | null
    try {
      payloadFailure = payloadProblem(kind, candidate.kindPayload)
    } catch (error) {
      return undoRefusal(kind, authorization, 'invalid-payload', `cannot validate authorized payload: ${errorDetail(error)}`)
    }
    if (payloadFailure) return undoRefusal(kind, authorization, 'invalid-payload', payloadFailure)

    return serialize(async () => {
      if (options.store.readOnly) {
        return undoRefusal(kind, authorization, 'owner-not-executable', 'Heimdall store became read-only before commit')
      }
      let nowMs: number
      try {
        nowMs = now()
        if (!Number.isFinite(nowMs)) throw new Error('clock returned a non-finite timestamp')
      } catch (error) {
        return undoRefusal(kind, authorization, 'owner-not-executable', `cannot timestamp enrollment: ${errorDetail(error)}`)
      }

      let existing: Enrollment | null
      try {
        existing = options.store.live(candidate.workspaceKey)
      } catch (error) {
        return undoRefusal(kind, authorization, 'owner-not-executable', `cannot inspect workspace enrollment: ${errorDetail(error)}`)
      }
      if (existing && existing.terminalAtMs !== null) existing = null
      if (existing && (existing.executionHostId !== executionHostId || existing.schedulerOwner !== schedulerOwner)) {
        return undoRefusal(kind, authorization, 'owner-not-executable', 'workspace is owned by a different execution host or scheduler')
      }
      if (existing?.enabled) {
        return undoRefusal(kind, authorization, 'duplicate-workspace', `workspace already has enabled watcher ${existing.watcherId}`)
      }
      if (existing && existing.kind !== settings.input.kind) {
        return undoRefusal(kind, authorization, 'invalid-payload', `disabled workspace watcher belongs to kind ${existing.kind}`)
      }
      if (existing && (!Number.isSafeInteger(existing.commandRevision) || existing.commandRevision < 0 ||
        existing.commandRevision >= Number.MAX_SAFE_INTEGER)) {
        return undoRefusal(kind, authorization, 'invalid-payload', 'existing watcher command revision is invalid')
      }
      if (existing?.malformed && !kind.validateEnrollment) {
        return undoRefusal(kind, authorization, 'invalid-payload', `existing watcher is malformed: ${existing.malformed}`)
      }
      try {
        await kind.validateEnrollment?.(
          JSON.parse(JSON.stringify(candidate)) as AuthorizedEnrollment,
          existing ? JSON.parse(JSON.stringify(existing)) as Enrollment : null
        )
      } catch (error) {
        return undoRefusal(kind, authorization, 'invalid-payload', `kind rejected enrollment: ${errorDetail(error)}`)
      }

      const nextRevision = existing ? existing.commandRevision + 1 : 0
      let budget = settings.budget
      let budgetGeneration: string | undefined
      try {
        if (existing) {
          if (existing.haltReason === 'operator-disarmed') {
            budgetGeneration = `rearm:${existing.watcherId}:${nextRevision}`
          } else {
            const usage = budgetUsage(options.store.journal(existing.watcherId), nowMs)
            if (!record(usage) || typeof usage.activeMs !== 'number' || !Number.isFinite(usage.activeMs) ||
              usage.activeMs < 0 || typeof usage.turns !== 'number' || !Number.isSafeInteger(usage.turns) || usage.turns < 0) {
              return await undoRefusal(kind, authorization, 'invalid-payload', 'existing budget usage is invalid')
            }
            const wallClockActiveMs = addAllowance(usage.activeMs, settings.budget.wallClockActiveMs)
            const turns = addAllowance(usage.turns, settings.budget.turns)
            if (wallClockActiveMs === undefined || turns === undefined) {
              return await undoRefusal(kind, authorization, 'invalid-payload', 're-armed budget limit is not finite')
            }
            budget = { wallClockActiveMs, turns }
          }
        }
      } catch (error) {
        return undoRefusal(kind, authorization, 'owner-not-executable', `cannot calculate workspace budget: ${errorDetail(error)}`)
      }

      let enrollment: Enrollment
      try {
        if (existing) {
          enrollment = {
            ...existing,
            ...candidate,
            repoId: candidate.repoId,
            worktreeId: candidate.worktreeId,
            undo: candidate.undo,
            owner: candidate.owner,
            ownerInterventionCapability: candidate.ownerInterventionCapability,
            watcherId: existing.watcherId,
            kind: settings.input.kind,
            enabled: true,
            paused: false,
            commandRevision: nextRevision,
            capabilities: settings.capabilities,
            budget,
            coordinator: existing.coordinator,
            orchestrationRunId: existing.orchestrationRunId,
            createdAtMs: existing.createdAtMs,
            terminalAtMs: null,
            parkReason: null,
            haltReason: null,
            malformed: undefined
          }
        } else {
          const watcherId = randomUUID()
          budgetGeneration = `initial:${watcherId}`
          enrollment = {
            ...candidate,
            watcherId,
            kind: settings.input.kind,
            enabled: true,
            paused: false,
            commandRevision: 0,
            capabilities: settings.capabilities,
            budget,
            coordinator: {
              handle: `heimdall-coordinator_${randomBytes(24).toString('base64url')}`,
              paneKey: `heimdall-pane_${randomBytes(24).toString('base64url')}`
            },
            orchestrationRunId: null,
            createdAtMs: nowMs,
            terminalAtMs: null,
            parkReason: null,
            haltReason: null
          }
        }
        if (existing) {
          if (candidate.repoId === undefined) delete enrollment.repoId
          if (candidate.worktreeId === undefined) delete enrollment.worktreeId
          if (candidate.undo === undefined) delete enrollment.undo
          if (candidate.ownerInterventionCapability === undefined) delete enrollment.ownerInterventionCapability
          delete enrollment.malformed
        }
      } catch (error) {
        return undoRefusal(kind, authorization, 'owner-not-executable', `cannot create enrollment identity: ${errorDetail(error)}`)
      }

      try {
        options.store.transaction(() => {
          const current = options.store.live(enrollment.workspaceKey)
          if (existing) {
            if (!current) {
              throw new CommitConflict('duplicate-workspace', 'workspace watcher disappeared while enrollment was being validated')
            }
            if (current.executionHostId !== executionHostId || current.schedulerOwner !== schedulerOwner) {
              throw new CommitConflict('owner-not-executable', 'workspace is owned by a different execution host or scheduler')
            }
            if (current.watcherId !== existing.watcherId || current.commandRevision !== existing.commandRevision) {
              throw new CommitConflict('duplicate-workspace', 'workspace watcher changed while enrollment was being validated')
            }
            if (current.kind !== settings.input.kind) {
              throw new CommitConflict('invalid-payload', `disabled workspace watcher belongs to kind ${current.kind}`)
            }
            if (current.enabled || current.terminalAtMs !== null) {
              throw new CommitConflict('duplicate-workspace', 'workspace watcher became enabled or terminal during re-arm')
            }
          } else if (current) {
            if (current.executionHostId !== executionHostId || current.schedulerOwner !== schedulerOwner) {
              throw new CommitConflict('owner-not-executable', 'workspace is owned by a different execution host or scheduler')
            }
            throw new CommitConflict('duplicate-workspace', `workspace already has watcher ${current.watcherId}`)
          }
          options.store.save(enrollment)
          if (budgetGeneration) {
            options.store.append(enrollment.watcherId, {
              eventId: `budget-generation:${enrollment.watcherId}:${enrollment.commandRevision}`,
              atMs: nowMs,
              class: 'fact',
              origin: 'owner',
              kind: 'evidence',
              resolved: true,
              evidenceKind: 'budget-generation',
              generation: budgetGeneration,
              wallClockActiveMs: budget.wallClockActiveMs,
              turns: budget.turns
            })
          }
          if (existing) {
            const open = new Map<string, JournalEntry>()
            for (const entry of options.store.journal(enrollment.watcherId)) {
              if (entry.kind !== 'escalation') continue
              const escalationId = typeof entry.escalationId === 'string' ? entry.escalationId : entry.eventId
              if (entry.status === 'acknowledged' || entry.resolved) open.delete(escalationId)
              else if (entry.status === 'open') open.set(escalationId, entry)
            }
            for (const [escalationId, entry] of open) {
              options.store.append(enrollment.watcherId, {
                eventId: `enrollment-rearm:${enrollment.watcherId}:${enrollment.commandRevision}:${entry.eventId}`,
                atMs: nowMs,
                class: 'fact',
                origin: 'owner',
                kind: 'escalation',
                resolved: true,
                escalationId,
                status: 'acknowledged',
                commandRevision: enrollment.commandRevision,
                ...(typeof entry.escalationKind === 'string' ? { escalationKind: entry.escalationKind } : {}),
                ...(typeof entry.foldCount === 'number' ? { foldCount: entry.foldCount } : {})
              })
            }
          }
        })
      } catch (error) {
        const reason = error instanceof CommitConflict ? error.reason : 'owner-not-executable'
        const detail = error instanceof CommitConflict ? error.message : `failed to persist enrollment: ${errorDetail(error)}`
        return undoRefusal(kind, authorization, reason, detail)
      }

      try {
        onEnrolled(JSON.parse(JSON.stringify(enrollment)) as Enrollment)
      } catch (error) {
        options.context.log(`Enrollment ${enrollment.watcherId} committed but observer failed: ${errorDetail(error)}`)
      }
      return { kind: existing ? 're-armed' : 'enrolled', enrollment }
    })
  }
  const validHandoffRequest = (value: unknown): value is HandoffRequest =>
    record(value) && isJsonValue(value) &&
    Object.keys(value).every((key) => key === 'kind' || key === 'kindPayload' || key === 'capabilities') &&
    typeof value.kind === 'string' && value.kind.length > 0 &&
    Object.hasOwn(value, 'kindPayload') && Object.hasOwn(value, 'capabilities') &&
    record(value.capabilities) && normalizeCapabilities(value.capabilities) !== null

  const replayHandoff = (watcherId: string, requestedKind?: string): HandoffResult | null => {
    const source = options.store.get(watcherId)
    if (!source || source.terminalAtMs === null) return null
    const terminal = options.store.journal(watcherId).find((entry) => entry.kind === 'terminal')
    const linkValue = terminal?.handoff
    if (!record(linkValue) || typeof linkValue.watcherId !== 'string' || linkValue.watcherId.length === 0 ||
      typeof linkValue.kind !== 'string' || linkValue.kind.length === 0) return null
    const link: HandoffLink = { watcherId: linkValue.watcherId, kind: linkValue.kind }
    if (requestedKind !== undefined && requestedKind !== link.kind) {
      return { kind: 'refused', reason: 'handoff-replay-mismatch', detail: 'source already handed off to a different target kind' }
    }
    const enrollment = options.store.get(link.watcherId)
    const summary = options.store.summary(watcherId)
    if (!enrollment || enrollment.kind !== link.kind || enrollment.workspaceKey !== source.workspaceKey ||
      enrollment.workspacePath !== source.workspacePath || enrollment.executionHostId !== source.executionHostId ||
      enrollment.schedulerOwner !== source.schedulerOwner || !summary) {
      return { kind: 'refused', reason: 'handoff-record-invalid', detail: 'recorded handoff successor or source summary is unavailable' }
    }
    return { kind: 'handed-off', enrollment, summary, link }
  }

  const refuseHandoff = (reason: string, detail: string): HandoffResult => ({ kind: 'refused', reason, detail })

  const handoff = async (
    sourceIdentity: Pick<Enrollment, 'watcherId' | 'commandRevision'>,
    terminalResult: Extract<StopResult, { kind: 'terminal' }>,
    guard: () => string | null
  ): Promise<HandoffResult> => {
    const terminalState = terminalResult.state
    const terminalReason = terminalResult.reason
    if (terminalState.length === 0 || terminalReason.length === 0) {
      return refuseHandoff('invalid-payload', 'handoff terminal state and reason must be non-empty strings')
    }
    const requestValue: unknown = terminalResult.handoff
    if (!validHandoffRequest(requestValue)) {
      return refuseHandoff('invalid-payload', 'handoff request must contain a kind, finite JSON payload, and capability map')
    }
    const request = JSON.parse(JSON.stringify(requestValue)) as HandoffRequest
    if (!Number.isSafeInteger(sourceIdentity.commandRevision) || sourceIdentity.commandRevision < 0) {
      return refuseHandoff('stale-command-revision', 'source command revision is invalid')
    }
    if (options.store.readOnly) return refuseHandoff('owner-not-executable', 'Heimdall store is read-only')

    let original: Enrollment | null
    try {
      const replay = replayHandoff(sourceIdentity.watcherId, request.kind)
      if (replay) return replay
      original = options.store.get(sourceIdentity.watcherId)
    } catch (error) {
      return refuseHandoff('source-unavailable', `cannot inspect source handoff state: ${errorDetail(error)}`)
    }
    if (!original) return refuseHandoff('source-removed', 'source watcher no longer exists')
    if (original.terminalAtMs !== null) return refuseHandoff('source-terminal', 'source watcher is already terminal without a handoff link')
    if (original.commandRevision !== sourceIdentity.commandRevision) {
      return refuseHandoff('stale-command-revision', 'source command revision changed before handoff authorization')
    }
    if (!original.enabled || original.paused || original.haltReason === 'operator-disarmed') {
      return refuseHandoff('source-not-executable', 'source watcher is paused, disabled, or disarmed')
    }

    const settings = enrollmentSettings({
      kind: request.kind,
      kindPayload: request.kindPayload,
      capabilities: request.capabilities,
      budget: { wallClockActiveMs: null, turns: null },
      owner: null
    })
    if (!settings) return refuseHandoff('invalid-payload', 'handoff request settings are invalid')
    const kind = options.registry.get(settings.input.kind)
    if (!kind) return refuseHandoff('unknown-kind', `unknown handoff kind ${settings.input.kind}`)

    let authorization: unknown
    try {
      authorization = await kind.authorizeEnrollment({
        kind: settings.input.kind,
        kindPayload: JSON.parse(JSON.stringify(settings.input.kindPayload)) as Json,
        capabilities: { ...settings.capabilities },
        budget: { wallClockActiveMs: null, turns: null },
        owner: null
      })
    } catch (error) {
      const detail = errorDetail(error)
      return refuseHandoff(
        error instanceof Error && error.name === 'InvalidEnrollmentAuthority' ? 'invalid-payload' : 'authorization-failed',
        `handoff authorization failed: ${detail}`
      )
    }

    const undoAuthorization = async (reason: string, detail: string): Promise<HandoffResult> => {
      try {
        await kind.undoAuthorization?.(authorization as AuthorizedEnrollment)
      } catch (error) {
        detail += `; authorization undo failed: ${errorDetail(error)}`
      }
      return refuseHandoff(reason, detail)
    }

    let candidate: AuthorizedEnrollment | null
    try {
      candidate = normalizeAuthorization(authorization, settings)
    } catch (error) {
      return undoAuthorization('invalid-payload', `invalid authorized workspace path: ${errorDetail(error)}`)
    }
    if (!candidate) {
      return undoAuthorization('invalid-payload', 'authorization returned invalid handoff authority or payload')
    }
    if (candidate.executionHostId !== executionHostId || candidate.schedulerOwner !== schedulerOwner ||
      candidate.executionHostId !== original.executionHostId || candidate.schedulerOwner !== original.schedulerOwner ||
      candidate.workspaceKey !== original.workspaceKey || candidate.workspacePath !== original.workspacePath ||
      (candidate.repoId ?? null) !== (original.repoId ?? null) ||
      (candidate.worktreeId ?? null) !== (original.worktreeId ?? null)) {
      return undoAuthorization('wrong-authority', 'handoff authorization must preserve the source canonical workspace, host, repository, and scheduler')
    }

    let payloadFailure: string | null
    try {
      payloadFailure = payloadProblem(kind, candidate.kindPayload)
    } catch (error) {
      return undoAuthorization('invalid-payload', `cannot validate handoff target payload: ${errorDetail(error)}`)
    }
    if (payloadFailure) return undoAuthorization('invalid-payload', payloadFailure)

    return serialize(async () => {
      if (options.store.readOnly) {
        return undoAuthorization('owner-not-executable', 'Heimdall store became read-only before handoff commit')
      }
      try {
        await kind.validateEnrollment?.(JSON.parse(JSON.stringify(candidate)) as AuthorizedEnrollment, null)
      } catch (error) {
        return undoAuthorization('invalid-payload', `kind rejected handoff enrollment: ${errorDetail(error)}`)
      }
      if (options.store.readOnly) {
        return undoAuthorization('owner-not-executable', 'Heimdall store became read-only during handoff validation')
      }
      let nowMs: number
      try {
        nowMs = now()
        if (!Number.isFinite(nowMs)) throw new Error('clock returned a non-finite timestamp')
      } catch (error) {
        return undoAuthorization('owner-not-executable', `cannot timestamp handoff: ${errorDetail(error)}`)
      }

      let replayed = false
      try {
        const committed = options.store.transaction((): HandoffResult => {
          const current = options.store.get(sourceIdentity.watcherId)
          if (!current) throw new HandoffConflict('source-removed', 'source watcher was removed before handoff commit')
          if (current.terminalAtMs !== null) {
            const replay = replayHandoff(sourceIdentity.watcherId, request.kind)
            if (replay?.kind === 'handed-off') {
              replayed = true
              return replay
            }
            throw new HandoffConflict(
              replay?.kind === 'refused' ? replay.reason : 'source-terminal',
              replay?.kind === 'refused' ? replay.detail : 'source watcher became terminal before handoff commit'
            )
          }
          if (current.commandRevision !== sourceIdentity.commandRevision ||
            current.commandRevision !== original.commandRevision) {
            throw new HandoffConflict('stale-command-revision', 'source command revision changed during handoff authorization')
          }
          if (!current.enabled || current.paused || current.haltReason === 'operator-disarmed') {
            throw new HandoffConflict('source-not-executable', 'source watcher was paused, disabled, or disarmed during handoff authorization')
          }
          if (current.kind !== original.kind || current.workspaceKey !== original.workspaceKey ||
            current.workspacePath !== original.workspacePath || current.executionHostId !== original.executionHostId ||
            current.schedulerOwner !== original.schedulerOwner || current.repoId !== original.repoId ||
            current.worktreeId !== original.worktreeId) {
            throw new HandoffConflict('source-ownership-changed', 'source workspace ownership changed during handoff authorization')
          }
          let guardFailure: string | null
          try {
            guardFailure = guard()
          } catch (error) {
            guardFailure = errorDetail(error)
          }
          if (guardFailure) throw new HandoffConflict('source-fenced', guardFailure)

          const occupied = options.store.live(candidate.workspaceKey)
          if (occupied && occupied.watcherId !== current.watcherId) {
            throw new HandoffConflict('duplicate-workspace', `workspace already has watcher ${occupied.watcherId}`)
          }
          const journal = options.store.journal(current.watcherId)
          const usage = budgetUsage(journal, nowMs, current.budget)
          if (!Number.isFinite(usage.activeMs) || usage.activeMs < 0 ||
            !Number.isSafeInteger(usage.turns) || usage.turns < 0) {
            throw new HandoffConflict('invalid-budget', 'source budget usage is invalid')
          }
          const remaining = (limit: number | null, spent: number): number | null =>
            limit === null ? null : Math.max(0, limit - spent)
          const budget: BudgetPolicy = {
            wallClockActiveMs: remaining(current.budget.wallClockActiveMs, usage.activeMs),
            turns: remaining(current.budget.turns, usage.turns)
          }
          const watcherId = randomUUID()
          const link: HandoffLink = { watcherId, kind: settings.input.kind }
          const successor: Enrollment = {
            ...candidate,
            watcherId,
            kind: settings.input.kind,
            enabled: true,
            paused: false,
            commandRevision: 0,
            capabilities: settings.capabilities,
            budget,
            owner: null,
            coordinator: {
              handle: `heimdall-coordinator_${randomBytes(24).toString('base64url')}`,
              paneKey: `heimdall-pane_${randomBytes(24).toString('base64url')}`
            },
            orchestrationRunId: null,
            createdAtMs: nowMs,
            terminalAtMs: null,
            parkReason: null,
            haltReason: null
          }
          const sourceTerminal: Enrollment = {
            ...current,
            enabled: false,
            terminalAtMs: nowMs,
            haltReason: terminalReason
          }
          const summary: TerminalSummary = {
            watcherId: current.watcherId,
            kind: current.kind,
            state: terminalState,
            reason: terminalReason,
            atMs: nowMs,
            budget: usage
          }
          options.store.save(sourceTerminal)
          options.store.append(current.watcherId, {
            eventId: `terminal:${current.watcherId}`,
            atMs: nowMs,
            kind: 'terminal',
            class: 'fact',
            origin: 'owner',
            resolved: true,
            state: terminalState,
            reason: terminalReason,
            handoff: link
          })
          options.store.save(successor)
          options.store.append(watcherId, {
            eventId: `budget-generation:${watcherId}:0`,
            atMs: nowMs,
            class: 'fact',
            origin: 'owner',
            kind: 'evidence',
            resolved: true,
            evidenceKind: 'budget-generation',
            generation: `initial:${watcherId}`,
            wallClockActiveMs: budget.wallClockActiveMs,
            turns: budget.turns
          })
          options.store.terminal(sourceTerminal, summary)
          return { kind: 'handed-off', enrollment: successor, summary, link }
        })
        if (replayed) {
          try { await kind.undoAuthorization?.(authorization as AuthorizedEnrollment) }
          catch (error) { options.context.log(`Handoff replay authorization cleanup failed: ${errorDetail(error)}`) }
        }
        return committed
      } catch (error) {
        if (error instanceof HandoffConflict) {
          return undoAuthorization(error.reason, error.message)
        }
        return undoAuthorization('commit-failed', `failed to persist handoff transaction: ${errorDetail(error)}`)
      }
    })
  }

  return {
    async enroll(input) {
      if (options.store.readOnly) {
        return refused('owner-not-executable', 'Heimdall store is read-only')
      }
      const settings = enrollmentSettings(input)
      if (!settings) return refused('invalid-payload', 'enrollment input, capabilities, budget, or owner configuration is invalid')
      const kind = options.registry.get(settings.input.kind)
      if (!kind) return refused('unknown-kind', `unknown enrollment kind ${settings.input.kind}`)
      let authorization: unknown
      try {
        authorization = await kind.authorizeEnrollment({
          kind: settings.input.kind,
          kindPayload: JSON.parse(JSON.stringify(settings.input.kindPayload)) as Json,
          capabilities: { ...settings.capabilities },
          budget: { ...settings.budget },
          owner: settings.owner === null ? null : { ...settings.owner },
          ...(settings.ownerInterventionCapability !== undefined
            ? { ownerInterventionCapability: settings.ownerInterventionCapability }
            : {})
        })
      } catch (error) {
        const detail = errorDetail(error)
        if ((error instanceof Error && error.name === 'InvalidEnrollmentAuthority') ||
          detail.includes('authorize hook returned an invalid authority')) {
          return refused('invalid-payload', detail)
        }
        return refused('owner-not-executable', `authorization failed: ${detail}`)
      }
      return finishAuthorized(kind, settings, authorization)
    },
    handoff
  }
}

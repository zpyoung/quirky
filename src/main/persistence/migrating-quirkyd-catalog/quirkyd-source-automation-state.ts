import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  QuirkydMigrationCatalogPayload,
  QuirkydMigrationManifestSource
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import {
  createQuirkydMigrationSourceScope,
  quirkydMigrationOwnerMatchesScope,
  quirkydMigrationOwnsRepoId,
  type QuirkydMigrationSourceScope,
  unqualifyQuirkydMigrationOwnerKey
} from './quirkyd-source-scope'
import { compareKeys } from './quirkyd-source-key-order'

export type QuirkydMigrationSourceAutomationInspection = {
  automations: Automation[]
  automationRuns: AutomationRun[]
  blockedAutomationCount: number
  blockedRunCount: number
}

export function collectQuirkydMigrationSourceAutomationState(
  state: PersistedState,
  source: QuirkydMigrationManifestSource,
  catalog: QuirkydMigrationCatalogPayload
): QuirkydMigrationSourceAutomationInspection {
  const scope = createQuirkydMigrationSourceScope({ source, catalog, repos: state.repos })
  const touchedAutomations = state.automations.filter((entry) =>
    automationTouchesScope(entry, scope)
  )
  const touchedAutomationIds = new Set(touchedAutomations.map((entry) => entry.id))
  const touchedRuns = state.automationRuns.filter(
    (entry) => touchedAutomationIds.has(entry.automationId) || runTouchesScope(entry, scope)
  )
  const runsByAutomationId = Map.groupBy(touchedRuns, (entry) => entry.automationId)
  const automationsById = Map.groupBy(touchedAutomations, (entry) => entry.id)
  const automations: Automation[] = []
  const automationRuns: AutomationRun[] = []
  let blockedAutomationCount = 0
  let blockedRunCount = 0

  for (const [automationId, matching] of automationsById) {
    const runs = runsByAutomationId.get(automationId) ?? []
    const eligible =
      matching.length === 1 &&
      automationCanTransfer(matching[0], scope) &&
      runs.every((run) => runCanTransfer(run, scope))
    if (!eligible) {
      blockedAutomationCount += matching.length
      blockedRunCount += runs.length
      continue
    }
    automations.push(projectAutomationToDestination(matching[0]))
    automationRuns.push(...runs.map(projectAutomationRunToDestination))
  }

  for (const [automationId, runs] of runsByAutomationId) {
    if (!automationsById.has(automationId)) {
      blockedRunCount += runs.length
    }
  }
  automations.sort((left, right) => compareKeys(left.id, right.id))
  automationRuns.sort((left, right) => compareKeys(left.id, right.id))
  return { automations, automationRuns, blockedAutomationCount, blockedRunCount }
}

export function automationTouchesScope(
  automation: Automation,
  scope: QuirkydMigrationSourceScope
): boolean {
  return (
    (automation.executionTargetType === 'ssh' && automation.executionTargetId === scope.targetId) ||
    // Why the target too: a generation is per target, so another host's can share the number.
    (scope.targetGeneration !== null &&
      automation.executionTargetId === scope.targetId &&
      automation.executionTargetGeneration === scope.targetGeneration) ||
    quirkydMigrationOwnsRepoId(scope, getAutomationRunRepoId(automation)) ||
    quirkydMigrationOwnerMatchesScope(automation.workspaceId, scope) ||
    contextTouchesScope(automation.runContext, scope) ||
    contextTouchesScope(automation.sourceContext, scope)
  )
}

function runTouchesScope(run: AutomationRun, scope: QuirkydMigrationSourceScope): boolean {
  return (
    quirkydMigrationOwnerMatchesScope(run.workspaceId, scope) ||
    contextTouchesScope(run.runContext, scope) ||
    contextTouchesScope(run.sourceContext, scope)
  )
}

function automationCanTransfer(
  automation: Automation,
  scope: QuirkydMigrationSourceScope
): boolean {
  return (
    automation.enabled === false &&
    automation.executionTargetType === 'ssh' &&
    automation.executionTargetId === scope.targetId &&
    automation.schedulerOwner === 'ssh_bridge' &&
    (automation.executionTargetGeneration === undefined ||
      automation.executionTargetGeneration === scope.targetGeneration) &&
    scope.repoIds.has(getAutomationRunRepoId(automation)) &&
    ownerCanTransfer(automation.workspaceId, scope) &&
    contextCanTransfer(automation.runContext, scope) &&
    contextCanTransfer(automation.sourceContext, scope)
  )
}

function runCanTransfer(run: AutomationRun, scope: QuirkydMigrationSourceScope): boolean {
  return (
    isFinalAutomationRunStatus(run.status) &&
    ownerCanTransfer(run.workspaceId, scope) &&
    contextCanTransfer(run.runContext, scope) &&
    contextCanTransfer(run.sourceContext, scope)
  )
}

function ownerCanTransfer(value: string | null, scope: QuirkydMigrationSourceScope): boolean {
  return value === null || quirkydMigrationOwnerMatchesScope(value, scope)
}

function contextTouchesScope(
  context: WorkspaceRunContext | TaskSourceContext | null | undefined,
  scope: QuirkydMigrationSourceScope
): boolean {
  return (
    context?.hostId === scope.hostId ||
    (!context?.hostId && quirkydMigrationOwnsRepoId(scope, context?.repoId))
  )
}

function contextCanTransfer(
  context: WorkspaceRunContext | TaskSourceContext | null | undefined,
  scope: QuirkydMigrationSourceScope
): boolean {
  if (!context) {
    return true
  }
  return (
    context.hostId === scope.hostId &&
    typeof context.repoId === 'string' &&
    scope.repoIds.has(context.repoId) &&
    (!context.projectHostSetupId || context.projectHostSetupId === context.repoId)
  )
}

function projectAutomationToDestination(source: Automation): Automation {
  const destination: Automation = {
    ...structuredClone(source),
    runContext: projectContextToDestination(source.runContext),
    sourceContext: projectContextToDestination(source.sourceContext),
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'remote_host_service',
    workspaceId: projectOwnerToDestination(source.workspaceId)
  }
  delete destination.executionTargetGeneration
  return destination
}

function projectAutomationRunToDestination(source: AutomationRun): AutomationRun {
  return {
    ...structuredClone(source),
    runContext: projectContextToDestination(source.runContext),
    sourceContext: projectContextToDestination(source.sourceContext),
    workspaceId: projectOwnerToDestination(source.workspaceId)
  }
}

function projectContextToDestination<T extends WorkspaceRunContext | TaskSourceContext>(
  context: T | null | undefined
): T | null {
  if (!context) {
    return null
  }
  return Object.assign(structuredClone(context), {
    hostId: LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: context.repoId ?? null
  })
}

function projectOwnerToDestination(value: string | null): string | null {
  return value === null ? null : unqualifyQuirkydMigrationOwnerKey(value)
}

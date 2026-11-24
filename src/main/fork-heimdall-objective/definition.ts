import type { AutomationSchedulerOwner } from '../../shared/automations-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ResolvedRuntimeFileTarget } from '../runtime/files/file-target'
import {
  ObjectiveCapabilitiesSchema,
  ObjectiveEnrollmentPayloadSchema,
  ObjectiveEnrollmentRequestSchema,
  type ObjectiveCapabilities,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import { OBJECTIVE_LANDING_LADDER } from '../../shared/fork-heimdall-objective/landing-ladder'
import type { EnrollmentAuthorizationScope } from '../../shared/fork-heimdall/kind-contract'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { isFolderRepo } from '../../shared/repo-kind'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { getAutomationSchedulerOwnerForExecutionHost } from '../persistence/scheduling-automations/automation-context-migration'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  createObjectiveEnrollmentWorktree,
  objectiveEnrollmentWorktreeRollback
} from './enrollment-worktree'
import {
  defaultObjectiveForgeAccess,
  objectiveForgeContext,
  type ObjectiveForgeAccess
} from './objective-forge-access'
import { getRepoMainWorktreeId } from '../../shared/worktree/id'

type ObjectiveRuntimeResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

export class ObjectiveOwnerNotExecutableError extends Error {
  readonly schedulerOwner: AutomationSchedulerOwner

  constructor(schedulerOwner: AutomationSchedulerOwner) {
    super(`Objective watcher owner is not executable: ${schedulerOwner}`)
    this.name = 'ObjectiveOwnerNotExecutableError'
    this.schedulerOwner = schedulerOwner
  }
}

function parseCapabilities(value: EnrollInput['capabilities']): ObjectiveCapabilities {
  const parsed = ObjectiveCapabilitiesSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      'Objective enrollment requires exactly plan, implement, review, check and land capabilities'
    )
  }
  return parsed.data
}
/**
 * Plan-off is safe only when this same objective already owns a usable approved plan.
 * Free-form existingPlan text is planner input, not an executable plan seed.
 */
export function assertObjectiveEnrollmentHasUsablePlan(
  candidate: AuthorizedEnrollment,
  existing: WatcherEnrollment | null,
  hasUsablePlan: boolean
): void {
  const capabilities = ObjectiveCapabilitiesSchema.parse(candidate.capabilities)
  if (capabilities.plan !== 'off') {
    return
  }
  const candidateContract = ObjectiveEnrollmentPayloadSchema.parse(candidate.kindPayload)
  const existingContract =
    existing?.kind === 'objective'
      ? ObjectiveEnrollmentPayloadSchema.safeParse(existing.kindPayload)
      : null
  const existingPlanMatches =
    existingContract?.success === true &&
    existingContract.data.objectiveText === candidateContract.objectiveText &&
    existingContract.data.writeTerritory.length === candidateContract.writeTerritory.length &&
    existingContract.data.writeTerritory.every((glob) =>
      candidateContract.writeTerritory.includes(glob)
    )
  if (!existing || !hasUsablePlan || !existingPlanMatches) {
    throw new Error('plan-off-requires-approved-plan')
  }
}

function assertRoleAgentsKnown(contract: ObjectiveEnrollmentPayload): void {
  for (const [role, agent] of Object.entries(contract.roleAgents)) {
    if (agent !== undefined && !isTuiAgent(agent)) {
      throw new Error(`Objective ${role} agent is unknown: ${agent}`)
    }
  }
}

function assertOwnerExecutable(
  owner: AutomationSchedulerOwner,
  storageAuthority: 'desktop' | 'runtime'
): void {
  if (
    (storageAuthority === 'desktop' && owner === 'remote_host_service') ||
    (storageAuthority === 'runtime' && owner !== 'local_host_service')
  ) {
    throw new ObjectiveOwnerNotExecutableError(owner)
  }
}

function schedulerOwnerFor(
  executionHostId: ExecutionHostId,
  storageAuthority: 'desktop' | 'runtime'
): AutomationSchedulerOwner {
  const routeOwner = getAutomationSchedulerOwnerForExecutionHost(executionHostId)
  assertOwnerExecutable(routeOwner, storageAuthority)
  return storageAuthority === 'runtime' ? 'remote_host_service' : routeOwner
}

async function resolveGitWorkspace(
  runtime: ObjectiveRuntimeResolver,
  repoId: string,
  worktreeId: string
): Promise<{
  kind: 'git'
  executionHostId: ExecutionHostId
  workspacePath: string
  worktreeId: string
  gitTarget: RuntimeGitTarget
}> {
  const target = await runtime.resolveRuntimeGitTarget(`id:${worktreeId}`)
  const worktree = target.worktree
  if (worktree.id !== worktreeId || worktree.repoId !== repoId) {
    throw new Error('Invalid objective worktree identity')
  }
  if (!worktree.path || worktree.git.isBare || worktree.git.prunable) {
    throw new Error('Objective Git workspace is unavailable')
  }
  return {
    kind: 'git',
    executionHostId: target.executionHostId,
    workspacePath: worktree.path,
    worktreeId,
    gitTarget: target
  }
}

async function resolveLegacyFolderWorkspace(
  runtime: ObjectiveRuntimeResolver,
  repo: Repo
): Promise<{
  kind: 'folder'
  executionHostId: ExecutionHostId
  workspacePath: string
  worktreeId: null
  gitTarget?: never
}> {
  const target = await runtime.resolveRuntimeFileTarget(`id:${getRepoMainWorktreeId(repo)}`)
  const worktree = target.worktree
  if (worktree.repoId !== repo.id || worktree.path !== repo.path) {
    throw new Error('Invalid objective folder workspace identity')
  }
  return {
    kind: 'folder',
    executionHostId: target.executionHostId,
    workspacePath: worktree.path,
    worktreeId: null
  }
}

async function resolveCanonicalFolderWorkspace(
  runtime: ObjectiveRuntimeResolver,
  repoId: string,
  worktreeId: string
): Promise<{
  kind: 'folder'
  executionHostId: ExecutionHostId
  workspacePath: string
  worktreeId: string
  gitTarget?: never
}> {
  const target = await runtime.resolveRuntimeFileTarget(`id:${worktreeId}`)
  const worktree = target.worktree
  if (worktree.id !== worktreeId || worktree.repoId !== repoId || !worktree.path) {
    throw new Error('Invalid objective folder workspace identity')
  }
  return {
    kind: 'folder',
    executionHostId: target.executionHostId,
    workspacePath: worktree.path,
    worktreeId
  }
}

/** Rebuilds every workspace and execution-host authority field from runtime/store state. */
export async function authorizeObjectiveEnrollment(
  runtime: QuirkyRuntimeService,
  store: Store,
  input: EnrollInput,
  storageAuthority: 'desktop' | 'runtime' = 'desktop',
  forge: ObjectiveForgeAccess = defaultObjectiveForgeAccess,
  scope?: EnrollmentAuthorizationScope
): Promise<AuthorizedEnrollment> {
  if (input.kind !== 'objective') {
    throw new Error('Objective enrollment requires the objective kind')
  }
  const capabilities = parseCapabilities(input.capabilities)
  const { newWorktree, ...candidate } = ObjectiveEnrollmentRequestSchema.parse(input.kindPayload)
  const folderScope = input.worktreeId ? parseWorkspaceKey(input.worktreeId) : null
  const canonicalFolderWorktreeId = folderScope?.type === 'folder' ? input.worktreeId : null
  const repo = store.getRepo(input.repoId)
  if (!repo && canonicalFolderWorktreeId === null) {
    throw new Error('Objective repository is unavailable')
  }

  if (newWorktree) {
    if (canonicalFolderWorktreeId !== null || (repo && isFolderRepo(repo))) {
      throw new Error('New objective worktree requires a Git repository')
    }
    if (input.worktreeId !== null) {
      throw new Error('New objective worktree cannot name an existing worktree')
    }
    if (!newWorktree.name.trim()) {
      throw new Error('New objective worktree requires a name')
    }
    assertRoleAgentsKnown(candidate)
    if (capabilities.plan === 'off') {
      throw new Error('plan-off-requires-approved-plan')
    }
    if (!repo) {
      throw new Error('Objective repository is unavailable')
    }
    schedulerOwnerFor(getRepoExecutionHostId(repo), storageAuthority)
  }

  let rollbackCreatedWorktree: (() => Promise<void>) | null = null
  try {
    let workspace:
      | Awaited<ReturnType<typeof resolveGitWorkspace>>
      | Awaited<ReturnType<typeof resolveLegacyFolderWorkspace>>
      | Awaited<ReturnType<typeof resolveCanonicalFolderWorkspace>>
    if (canonicalFolderWorktreeId !== null) {
      workspace = await resolveCanonicalFolderWorkspace(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeFileTarget is protected on QuirkyRuntimeService; runtime satisfies this narrower resolver shape at runtime.
        runtime as unknown as ObjectiveRuntimeResolver,
        input.repoId,
        canonicalFolderWorktreeId
      )
    } else if (repo && isFolderRepo(repo)) {
      if (input.worktreeId !== null) {
        throw new Error('Folder objective enrollment cannot name a Git worktree')
      }
      workspace = await resolveLegacyFolderWorkspace(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeFileTarget is protected on QuirkyRuntimeService; runtime satisfies this narrower resolver shape at runtime.
        runtime as unknown as ObjectiveRuntimeResolver,
        repo
      )
    } else {
      if (!repo) {
        throw new Error('Objective repository is unavailable')
      }
      let worktreeId = input.worktreeId
      if (newWorktree) {
        const created = await createObjectiveEnrollmentWorktree(runtime, repo, newWorktree)
        worktreeId = created.worktree.id
        rollbackCreatedWorktree = objectiveEnrollmentWorktreeRollback(
          runtime,
          worktreeId,
          getRepoExecutionHostId(repo)
        )
        scope?.onAbandoned(rollbackCreatedWorktree)
      }
      if (!worktreeId) {
        throw new Error('Git objective enrollment requires an explicit worktree')
      }
      workspace = await resolveGitWorkspace(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeGitTarget is protected on QuirkyRuntimeService; runtime satisfies this narrower resolver shape at runtime.
        runtime as unknown as ObjectiveRuntimeResolver,
        repo.id,
        worktreeId
      )
    }

    const folder = workspace.kind === 'folder'
    const contract: ObjectiveEnrollmentPayload = {
      ...candidate,
      workspaceKind: folder ? 'folder' : 'git',
      maxConcurrency: folder ? 1 : candidate.maxConcurrency
    }
    if (folder && contract.landingBar !== 'files-on-disk') {
      throw new Error('landing-bar-requires-git')
    }
    const requiresHostedReview =
      OBJECTIVE_LANDING_LADDER.indexOf(contract.landingBar) >=
      OBJECTIVE_LANDING_LADDER.indexOf('hosted-review')
    if (!folder && workspace.worktreeId === null && requiresHostedReview) {
      throw new Error('landing-bar-requires-worktree')
    }
    assertRoleAgentsKnown(contract)

    if (workspace.kind === 'git' && requiresHostedReview) {
      const provider = await forge.detectProvider(
        objectiveForgeContext({
          kind: 'git',
          executionHostId: workspace.executionHostId,
          workspacePath: workspace.workspacePath,
          gitTarget: workspace.gitTarget
        })
      )
      if (provider !== 'github' && provider !== 'gitlab') {
        throw new Error('landing-bar-requires-supported-forge')
      }
    }
    const schedulerOwner = schedulerOwnerFor(workspace.executionHostId, storageAuthority)

    return {
      kind: 'objective',
      workspaceKey: `${workspace.executionHostId}::${workspace.workspacePath}`,
      executionHostId: workspace.executionHostId,
      repoId: input.repoId,
      worktreeId: workspace.worktreeId,
      workspacePath: workspace.workspacePath,
      schedulerOwner,
      capabilities,
      budget: structuredClone(input.budget),
      kindPayload: contract
    }
  } catch (error) {
    await rollbackCreatedWorktree?.()
    throw error
  }
}

export function objectiveContractFromEnrollment(
  enrollment: Pick<WatcherEnrollment, 'kind' | 'kindPayload'>
): ObjectiveEnrollmentPayload {
  if (enrollment.kind !== 'objective') {
    throw new Error('Enrollment is not an objective watcher')
  }
  return ObjectiveEnrollmentPayloadSchema.parse(enrollment.kindPayload)
}

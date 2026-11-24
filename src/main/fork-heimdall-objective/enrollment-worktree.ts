import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { ObjectiveNewWorktreeRequest } from '../../shared/fork-heimdall-objective/contract-types'
import type { Repo } from '../../shared/repo-types'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'

async function listNamedWorktreeIds(
  runtime: QuirkyRuntimeService,
  repo: Repo,
  name: string
): Promise<string[]> {
  // a cached or truncated listing could hide a pre-existing same-named worktree and mark it stranded
  runtime.invalidateWorktreeCatalog(repo.id)
  const listed = await runtime.listManagedWorktrees(`id:${repo.id}`, Number.MAX_SAFE_INTEGER)
  return listed.worktrees
    .filter((worktree) => worktree.displayName === name)
    .map((worktree) => worktree.id)
}

async function removeStrandedWorktrees(
  runtime: QuirkyRuntimeService,
  repo: Repo,
  name: string,
  preexisting: ReadonlySet<string>
): Promise<void> {
  try {
    const stranded = (await listNamedWorktreeIds(runtime, repo, name)).filter(
      (id) => !preexisting.has(id)
    )
    for (const id of stranded) {
      await objectiveEnrollmentWorktreeRollback(runtime, id, getRepoExecutionHostId(repo))()
    }
  } catch (error) {
    console.warn('Objective enrollment worktree rollback failed', error)
  }
}

/**
 * Creates an independent, inactive workspace for an objective enrollment on its repo's host.
 * A create that fails after its checkout exists removes that checkout before rethrowing.
 */
export async function createObjectiveEnrollmentWorktree(
  runtime: QuirkyRuntimeService,
  repo: Repo,
  request: ObjectiveNewWorktreeRequest
) {
  const preexisting = new Set(await listNamedWorktreeIds(runtime, repo, request.name))
  try {
    return await runtime.createManagedWorktree({
      repoSelector: `id:${repo.id}`,
      name: request.name,
      ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
      displayName: request.name,
      activate: false,
      lineage: { noParent: true },
      comment: `Objective enrollment: ${request.name}`
    })
  } catch (error) {
    await removeStrandedWorktrees(runtime, repo, request.name, preexisting)
    throw error
  }
}

/**
 * Returns the removal of a workspace created by a refused objective enrollment on its execution
 * host. The removal runs at most once and never throws, so every failure path may invoke it.
 */
export function objectiveEnrollmentWorktreeRollback(
  runtime: QuirkyRuntimeService,
  worktreeId: string,
  hostId: ExecutionHostId
): () => Promise<void> {
  let removal: Promise<void> | null = null
  return () => {
    removal ??= runtime.removeManagedWorktree(`id:${worktreeId}`, { force: true, hostId }).then(
      () => undefined,
      (error: unknown) => {
        console.warn('Objective enrollment worktree rollback failed', error)
      }
    )
    return removal
  }
}

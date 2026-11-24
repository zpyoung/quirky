import { defineMethod } from '../core'
import type { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { SkillDeleteRequestSchema } from '../../../../shared/skill-delete-contract'
import {
  previewSkillDeleteRequest,
  runSkillDeleteRequest,
  type SkillDeleteRequestDependencies
} from '../../../skills/skill-delete/request-service'
import type { SkillDiscoveryTargetSchema } from '../../../../shared/skills'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../../../skills/skill-discovery-target'
import type { QuirkyRuntimeService } from '../../quirky-runtime'
import { SkillsDiscoverParams } from '../../../../shared/rpc-contract/skills-params'

/** Exported so the delete plan's root rebuild resolves its target exactly the
 *  way `skills.discover` resolved the scan's — including WSL. */
export function resolveDiscoveryTarget(
  params: z.infer<typeof SkillDiscoveryTargetSchema>,
  runtime: Pick<QuirkyRuntimeService, 'resolveProjectRuntimeForWorktree'>
) {
  const target = params.projectRuntime
    ? params
    : {
        ...params,
        projectRuntime: runtime.resolveProjectRuntimeForWorktree(params.worktreeId)
      }
  return resolveSkillDiscoveryTarget(target)
}

function skillDeleteDependencies(
  runtime: Pick<QuirkyRuntimeService, 'listRepos' | 'resolveSkillDiscoveryProviderRoots'>
): SkillDeleteRequestDependencies {
  return {
    repos: () => runtime.listRepos(),
    resolveProviderRootOverrides: (target) => runtime.resolveSkillDiscoveryProviderRoots(target),
    userDataPath: getAppEnvironment().getPath('userData')
  }
}

export const SKILL_METHODS = [
  defineMethod({
    name: 'skills.discover',
    permission: 'workspace',
    params: SkillsDiscoverParams,
    handler: async (params, { runtime }) => {
      // Why: the executing runtime owns WSL project preferences. Remote callers
      // send worktree identity only; trusting their projectRuntime absence
      // would scan this host's native filesystem for a WSL-configured project.
      const resolvedTarget = resolveDiscoveryTarget(params, runtime)
      return discoverSkillsOnTarget(resolvedTarget, runtime.listRepos(), {
        providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(resolvedTarget),
        refresh: params.refresh === true
      })
    }
  }),
  defineMethod({
    name: 'skills.previewDelete',
    permission: 'workspace',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      previewSkillDeleteRequest(
        params,
        resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  defineMethod({
    name: 'skills.delete',
    permission: 'skills-admin',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      runSkillDeleteRequest(
        params,
        resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  })
]

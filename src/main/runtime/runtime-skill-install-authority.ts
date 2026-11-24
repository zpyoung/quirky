import {
  resolveEnvironmentSkillProviderRoots,
  withClaudeSkillProviderRoot
} from '../skills/skill-provider-runtime-roots'
import type { SkillProviderRootOverrides } from '../skills/skill-provider-destinations'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'

export async function resolveSkillProviderRoots(
  host: RuntimeSkillCommandHost,
  destination: {
    scope: 'global' | 'workspace'
    homeDirectory: string
    workspaceDirectory?: string
    wslDistro?: string
  }
): Promise<SkillProviderRootOverrides> {
  if (destination.scope !== 'global') {
    return {}
  }
  const roots = resolveEnvironmentSkillProviderRoots()
  const config = host.getClaudeConfigDirectory?.({ runtime: 'host' })
  return withClaudeSkillProviderRoot(roots, config)
}

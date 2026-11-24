import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslSkillProviderRoots,
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
  const roots = destination.wslDistro
    ? await resolveWslSkillProviderRoots(destination.wslDistro)
    : resolveEnvironmentSkillProviderRoots()
  const config = host.getClaudeConfigDirectory?.(
    destination.wslDistro
      ? { runtime: 'wsl', wslDistro: destination.wslDistro }
      : { runtime: 'host' }
  )
  return withClaudeSkillProviderRoot(roots, config)
}

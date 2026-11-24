import { homedir } from 'node:os'
import { toLinuxPath } from '../wsl'
import type {
  RuntimeSkillCommandSurface,
  RuntimeSkillCommandHost
} from './runtime-skill-command-contract'
import { resolveSkillProviderRoots } from './runtime-skill-install-authority'

export class RuntimeSkillCommands implements RuntimeSkillCommandSurface {
  constructor(private readonly host: RuntimeSkillCommandHost) {}

  async resolveSkillDiscoveryProviderRoots(target: {
    kind: 'native-host' | 'wsl'
    distro?: string
  }) {
    const roots = await resolveSkillProviderRoots(this.host, {
      scope: 'global',
      homeDirectory: homedir(),
      ...(target.kind === 'wsl' && target.distro ? { wslDistro: target.distro } : {})
    })
    return target.kind === 'wsl'
      ? Object.fromEntries(
          Object.entries(roots).map(([provider, root]) => [provider, toLinuxPath(root)])
        )
      : roots
  }
}

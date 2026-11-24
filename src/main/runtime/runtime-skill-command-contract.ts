import type { SkillProviderRootOverrides } from '../skills/skill-provider-destinations'
import type { RuntimeSkillCommands } from './runtime-skill-command-surface'

export type RuntimeSkillCommandSurface = {
  resolveSkillDiscoveryProviderRoots(target: {
    kind: 'native-host' | 'wsl'
    distro?: string
  }): Promise<SkillProviderRootOverrides>
}

export function installRuntimeSkillCommandSurface(
  target: RuntimeSkillCommandSurface,
  commands: RuntimeSkillCommands
): void {
  const targetMethods = target as unknown as Record<string, (...args: never[]) => unknown>
  const ownerMethods = commands as unknown as Record<string, (...args: never[]) => unknown>
  let prototype: object | null = Object.getPrototypeOf(commands)
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor') {
        targetMethods[name] = ownerMethods[name]!.bind(commands)
      }
    }
    prototype = Object.getPrototypeOf(prototype)
  }
}

export type RuntimeSkillCommandHost = {
  getClaudeConfigDirectory?(
    target: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }
  ): string | null
}

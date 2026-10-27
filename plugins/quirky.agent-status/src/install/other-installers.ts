import { join } from 'node:path'
import { type InstallEnv, type Installer } from '../types.ts'
import { dirOverride } from './common.ts'
import { ownedFileInstaller } from './files-owned.ts'
import { ampPluginSource } from './sources/amp.ts'
import { openCodePluginSource, type OpenCodeFamilyAgent } from './sources/opencode.ts'
import { PI_EXTENSION_FILE, piExtensionSource, type PiAgentKind } from './sources/pi.ts'
import { jcodeInstaller, kimiInstaller } from './toml-installers.ts'
import { dshInstaller, hermesInstaller } from './yaml-installers.ts'

function xdgConfigHome(target: InstallEnv): string {
  return dirOverride(target.env.XDG_CONFIG_HOME, join(target.home, '.config'))
}

export const ampInstaller = ownedFileInstaller({
  agent: 'amp',
  file: (target) => ({ path: join(xdgConfigHome(target), 'amp', 'plugins', 'quirky-agent-status.ts'), content: ampPluginSource() })
})

/** `$OPENCODE_CONFIG_DIR` names a whole config directory, so the plugin goes in its `plugins/`. */
function openCodePluginsDir(target: InstallEnv): string {
  const override = dirOverride(target.env.OPENCODE_CONFIG_DIR, '')
  return join(override || join(xdgConfigHome(target), 'opencode'), 'plugins')
}

function mimoPluginsDir(target: InstallEnv): string {
  const override = dirOverride(target.env.MIMOCODE_HOME, '')
  return override ? join(override, 'config', 'plugins') : join(xdgConfigHome(target), 'mimocode', 'plugins')
}

function openCodeFamilyInstaller(agent: OpenCodeFamilyAgent): Installer {
  return ownedFileInstaller({
    agent,
    file: (target) => ({
      path: join(agent === 'mimo-code' ? mimoPluginsDir(target) : openCodePluginsDir(target), `quirky-${agent}-status.js`),
      content: openCodePluginSource(agent)
    })
  })
}

export const opencodeInstaller = openCodeFamilyInstaller('opencode')
export const opencode2Installer = openCodeFamilyInstaller('opencode2')
export const mimoCodeInstaller = openCodeFamilyInstaller('mimo-code')

const PI_AGENT_DIRS: Record<PiAgentKind, { env: string; fallback: string }> = {
  pi: { env: 'PI_CODING_AGENT_DIR', fallback: join('.pi', 'agent') },
  omp: { env: 'PI_CODING_AGENT_DIR', fallback: join('.omp', 'agent') },
  'prime-agent': { env: 'PRIME_AGENT_CODING_AGENT_DIR', fallback: join('.prime', 'agent') }
}

/**
 * Pi and Oh My Pi both read `PI_CODING_AGENT_DIR`, so when it is set they share one extension
 * file; their sources are identical for that reason.
 */
function piFamilyInstaller(agent: PiAgentKind): Installer {
  const { env, fallback } = PI_AGENT_DIRS[agent]
  return ownedFileInstaller({
    agent,
    file: (target) => ({
      path: join(dirOverride(target.env[env], join(target.home, fallback)), 'extensions', PI_EXTENSION_FILE),
      content: piExtensionSource(agent)
    })
  })
}

export const piInstaller = piFamilyInstaller('pi')
export const ompInstaller = piFamilyInstaller('omp')
export const primeAgentInstaller = piFamilyInstaller('prime-agent')

/** Every installer whose agent keeps its hooks in a TOML or YAML file or a generated plugin. */
export const OTHER_INSTALLERS: Installer[] = [
  kimiInstaller,
  jcodeInstaller,
  dshInstaller,
  hermesInstaller,
  ampInstaller,
  opencodeInstaller,
  opencode2Installer,
  mimoCodeInstaller,
  piInstaller,
  ompInstaller,
  primeAgentInstaller
]

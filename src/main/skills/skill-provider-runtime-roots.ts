import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { isAbsolute, join, resolve, type posix } from 'node:path'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'

const PROVIDER_ROOT_MAX_LENGTH = 32_768

type HomePathApi = Pick<typeof posix, 'dirname' | 'isAbsolute' | 'relative' | 'sep'>

/**
 * Kiro documents ignoring a `KIRO_HOME` at the filesystem root, the user home or
 * an ancestor of it; Quirky applies that rule to every `homeEnv` on purpose, since
 * `<home>/skills` there would be an unrelated folder.
 */
function isUsableProviderHome(candidate: string, userHome: string, pathApi: HomePathApi): boolean {
  if (pathApi.dirname(candidate) === candidate) {
    return false
  }
  const toUserHome = pathApi.relative(candidate, userHome)
  return (
    toUserHome === '..' ||
    toUserHome.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(toUserHome)
  )
}

function normalizedRoot(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (
    !candidate ||
    candidate.length > PROVIDER_ROOT_MAX_LENGTH ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    return null
  }
  return resolve(candidate)
}

export function resolveEnvironmentSkillProviderRoots(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): SkillProviderRootOverrides {
  const roots: SkillProviderRootOverrides = {}
  for (const provider of SKILL_INSTALL_PROVIDERS) {
    const home = provider.homeEnv ? normalizedRoot(env[provider.homeEnv]) : null
    if (home && isUsableProviderHome(home, resolve(userHome), path)) {
      roots[provider.id] = join(home, 'skills')
    }
  }
  return roots
}

// Why: `HERMES_HOME` relocates a whole Hermes profile tree (`hermes -p coder`),
// and the rest of Quirky already treats it as authoritative. Hermes is not an
// install provider, so it stays out of `SkillProviderRootOverrides`.
export function resolveEnvironmentHermesSkillsRoot(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const hermesHome = normalizedRoot(env.HERMES_HOME)
  return hermesHome ? join(hermesHome, 'skills') : null
}

function isExistingDirectory(candidate: string): boolean {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
}

/**
 * The Hermes home when `HERMES_HOME` is unset. Windows installs land in
 * `%LOCALAPPDATA%\hermes`, not a dotfolder in the user profile, so the POSIX
 * `~/.hermes` default discovers nothing there. The dotfolder still wins on
 * Windows when it exists and the LOCALAPPDATA tree does not, which is the
 * pre-LOCALAPPDATA install Hermes itself keeps honouring rather than orphaning.
 */
export function resolveDefaultHermesSkillsRoot(input: {
  homeDir: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  directoryExists?: (candidate: string) => boolean
}): string {
  const dotfolderHome = join(input.homeDir, '.hermes')
  if ((input.platform ?? process.platform) !== 'win32') {
    return join(dotfolderHome, 'skills')
  }
  const localAppData = normalizedRoot((input.env ?? process.env).LOCALAPPDATA)
  if (!localAppData) {
    return join(dotfolderHome, 'skills')
  }
  const localAppDataHome = join(localAppData, 'hermes')
  const directoryExists = input.directoryExists ?? isExistingDirectory
  return !directoryExists(localAppDataHome) && directoryExists(dotfolderHome)
    ? join(dotfolderHome, 'skills')
    : join(localAppDataHome, 'skills')
}

export function withClaudeSkillProviderRoot(
  roots: SkillProviderRootOverrides,
  claudeConfigDirectory: string | null | undefined
): SkillProviderRootOverrides {
  const configDirectory = normalizedRoot(claudeConfigDirectory ?? undefined)
  return configDirectory ? { ...roots, claude: join(configDirectory, 'skills') } : roots
}

import { createHash } from 'node:crypto'
import { gitApi } from '@quirky/git'
import type { EffectiveHooks, HookScript, ProjectSettings } from '@quirky/protocol'
import type { HookKind } from './store'

/** The shared hooks file as read from the repo: `quirky.yaml` wins over `orca.yaml`. */
export type HooksFile = { name: 'quirky.yaml' | 'orca.yaml'; text: string }

/** The hash the user approved for each shared script kind, when they have. */
export type TrustedHashes = Partial<Record<HookKind, string>>

const FILE_NAMES = ['quirky.yaml', 'orca.yaml'] as const
const UNSUPPORTED_KEYS = ['defaultTabs', 'environmentRecipes']
const KNOWN_KEYS = ['scripts', 'setupAgentStartupPolicy', 'worktree', 'issueCommand', ...UNSUPPORTED_KEYS]
const STARTUP_POLICIES = ['start-immediately', 'wait-for-setup']

/** The identity of a script for trust: sha256 of its text without surrounding whitespace, as hex. */
export function hashScript(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex')
}

/**
 * Reads the shared hooks file at `ref`: `quirky.yaml`, else `orca.yaml`. Null when neither exists
 * there, or when the repo can't be read (no commits, a folder, a vanished path).
 */
export async function readHooksFile(repoPath: string, ref: string): Promise<HooksFile | null> {
  for (const name of FILE_NAMES) {
    let text: string | null = null
    try {
      text = await gitApi().showFile(repoPath, ref, name)
    } catch {
      text = null
    }
    if (text !== null) return { name, text }
  }
  return null
}

type SharedHooks = {
  setup: string | null
  archive: string | null
  issueCommand: string | null
  agentStartup: 'start-immediately' | 'wait-for-setup' | null
  sharedDirectories: string[]
  warnings: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function scriptOf(value: unknown, label: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    warnings.push(`${label} must be a string`)
    return null
  }
  return value.trim() === '' ? null : value.trim()
}

/** What a hooks file says; a file that doesn't parse or isn't a mapping says nothing, with a warning. */
function parseShared(file: HooksFile): SharedHooks {
  const shared: SharedHooks = { setup: null, archive: null, issueCommand: null, agentStartup: null, sharedDirectories: [], warnings: [] }
  let document: unknown
  try {
    document = Bun.YAML.parse(file.text)
  } catch (error) {
    shared.warnings.push(`${file.name} could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
    return shared
  }
  if (document === null || document === undefined) return shared
  if (!isRecord(document)) {
    shared.warnings.push(`${file.name} must be a mapping at the top level`)
    return shared
  }

  const { scripts, setupAgentStartupPolicy, worktree } = document
  if (scripts !== undefined && scripts !== null) {
    if (isRecord(scripts)) {
      shared.setup = scriptOf(scripts.setup, 'scripts.setup', shared.warnings)
      shared.archive = scriptOf(scripts.archive, 'scripts.archive', shared.warnings)
    } else shared.warnings.push('scripts must be a mapping')
  }
  shared.issueCommand = scriptOf(document.issueCommand, 'issueCommand', shared.warnings)
  if (setupAgentStartupPolicy !== undefined) {
    if (typeof setupAgentStartupPolicy === 'string' && STARTUP_POLICIES.includes(setupAgentStartupPolicy)) {
      shared.agentStartup = setupAgentStartupPolicy as SharedHooks['agentStartup']
    } else shared.warnings.push('setupAgentStartupPolicy must be start-immediately or wait-for-setup')
  }
  const directories = isRecord(worktree) ? worktree.sharedDirectories : undefined
  if (directories !== undefined) {
    if (Array.isArray(directories) && directories.every((entry) => typeof entry === 'string')) shared.sharedDirectories = directories
    else shared.warnings.push('worktree.sharedDirectories must be a list of strings')
  }
  for (const key of Object.keys(document)) {
    if (UNSUPPORTED_KEYS.includes(key)) shared.warnings.push(`${key} is recognised but not supported yet`)
    else if (!KNOWN_KEYS.includes(key)) shared.warnings.push(`unrecognised key ${key}`)
  }
  return shared
}

function mergeScript(file: HooksFile | null, shared: string | null, local: string | null, source: ProjectSettings['commandSource'], trusted: string | undefined): HookScript | null {
  const policy = source ?? (local ? 'local-only' : 'shared-only')
  const useShared = shared !== null && policy !== 'local-only'
  const useLocal = local !== null && policy !== 'shared-only'
  if (!useShared && !useLocal) return null

  const badge = [useShared ? file!.name : null, useLocal ? 'local settings' : null].filter(Boolean).join(' + ')
  const hash = shared === null ? '' : hashScript(shared)
  return {
    text: [useShared ? shared : null, useLocal ? local : null].filter((part) => part !== null).join('\n'),
    source: useShared && useLocal ? 'both' : useShared ? 'shared' : 'local',
    badge,
    shared: useShared ? { text: shared, hash, trusted: trusted === hash, changed: trusted !== undefined && trusted !== hash } : null
  }
}

/**
 * The setup, archive and issue-command hooks that apply to a project: the shared file merged with
 * the project's local scripts by its command-source policy, with the trust state of each shared script.
 * A script that fails to parse or is the wrong type is ignored with a warning, never an error.
 */
export function effectiveHooks(file: HooksFile | null, settings: ProjectSettings, trusted: TrustedHashes): EffectiveHooks {
  const shared = file ? parseShared(file) : null
  const local = (text: string) => (text.trim() === '' ? null : text.trim())
  return {
    file: file?.name ?? null,
    setup: mergeScript(file, shared?.setup ?? null, local(settings.setupScript), settings.commandSource, trusted.setup),
    archive: mergeScript(file, shared?.archive ?? null, local(settings.archiveScript), settings.commandSource, trusted.archive),
    issueCommand: mergeScript(file, shared?.issueCommand ?? null, local(settings.issueCommand ?? ''), settings.commandSource, trusted.issue),
    agentStartup: settings.agentStartup ?? shared?.agentStartup ?? 'start-immediately',
    sharedDirectories: shared?.sharedDirectories ?? [],
    warnings: shared?.warnings ?? []
  }
}

/** The shared script text of each kind in `file`, for recording trust; empty when it has none. */
export function sharedScripts(file: HooksFile | null): Partial<Record<HookKind, string>> {
  const shared = file ? parseShared(file) : null
  return {
    ...(shared?.setup ? { setup: shared.setup } : {}),
    ...(shared?.archive ? { archive: shared.archive } : {}),
    ...(shared?.issueCommand ? { issue: shared.issueCommand } : {})
  }
}

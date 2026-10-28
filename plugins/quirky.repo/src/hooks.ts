import { createHash } from 'node:crypto'
import { gitApi } from '@quirky/git'
import type { EffectiveHooks, HookScript, ProjectSettings } from '@quirky/protocol'
import type { HookKind } from './store'

/** The shared hooks file as read from the repo: `quirky.yaml` wins over `orca.yaml`. */
export type HooksFile = { name: 'quirky.yaml' | 'orca.yaml'; text: string }

export type DefaultTabTemplate = { title?: string; color?: string; command?: string }
export type EnvironmentRecipe = {
  id: string
  name: string
  create: string
  checkoutMode?: 'orca-worktree' | 'provisioned-root'
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: true
}
export type EnvironmentRecipeDiagnostic = { index: number; field?: string; message: string }
export type ScriptTrust = { text: string; hash: string; trusted: boolean; changed: boolean }
export type EffectiveRepoHooks = EffectiveHooks & {
  defaultTabs?: DefaultTabTemplate[]
  defaultTabsTrust?: ScriptTrust | null
  environmentRecipes?: EnvironmentRecipe[]
  environmentRecipeDiagnostics?: EnvironmentRecipeDiagnostic[]
  defaultTabsRunCommands?: boolean
}

/** The hash the user approved for each shared script kind, when they have. */
export type TrustedHashes = Partial<Record<HookKind, string>>

const FILE_NAMES = ['quirky.yaml', 'orca.yaml'] as const
const KNOWN_KEYS = ['scripts', 'setupAgentStartupPolicy', 'worktree', 'issueCommand', 'defaultTabs', 'environmentRecipes']
const STARTUP_POLICIES = ['start-immediately', 'wait-for-setup']
const DEFAULT_TAB_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/
const RECIPE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_CONFIG_ITEMS = 100

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
  defaultTabs: DefaultTabTemplate[]
  environmentRecipes: EnvironmentRecipe[]
  environmentRecipeDiagnostics: EnvironmentRecipeDiagnostic[]
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
function textField(record: Record<string, unknown>, key: string, maximum: number): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= maximum ? text : undefined
}

function parseDefaultTabs(value: unknown, warnings: string[]): DefaultTabTemplate[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_CONFIG_ITEMS) {
    warnings.push(`defaultTabs must be a list of at most ${MAX_CONFIG_ITEMS} entries`)
    return []
  }
  const tabs: DefaultTabTemplate[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      warnings.push(`defaultTabs[${index + 1}] must be a mapping`)
      continue
    }
    const title = textField(item, 'title', 200)
    const command = textField(item, 'command', 4096)
    const rawColor = textField(item, 'color', 7)
    const color = rawColor && DEFAULT_TAB_COLOR_RE.test(rawColor) ? rawColor : undefined
    if (item.title !== undefined && title === undefined) warnings.push(`defaultTabs[${index + 1}].title must be a non-empty string of at most 200 characters`)
    if (item.command !== undefined && command === undefined) warnings.push(`defaultTabs[${index + 1}].command must be a non-empty string of at most 4096 characters`)
    if (item.color !== undefined && color === undefined) warnings.push(`defaultTabs[${index + 1}].color must be a #RGB or #RRGGBB value`)
    if (!title && !command && !color) continue
    tabs.push({ ...(title ? { title } : {}), ...(color ? { color } : {}), ...(command ? { command } : {}) })
  }
  return tabs
}

function parseEnvironmentRecipes(value: unknown): { recipes: EnvironmentRecipe[]; diagnostics: EnvironmentRecipeDiagnostic[] } {
  const diagnostics: EnvironmentRecipeDiagnostic[] = []
  if (value === undefined || value === null) return { recipes: [], diagnostics }
  if (!Array.isArray(value)) {
    diagnostics.push({ index: 0, message: 'environmentRecipes must be a list.' })
    return { recipes: [], diagnostics }
  }
  if (value.length > MAX_CONFIG_ITEMS) {
    diagnostics.push({ index: MAX_CONFIG_ITEMS, message: `At most ${MAX_CONFIG_ITEMS} environment recipes are supported.` })
    return { recipes: [], diagnostics }
  }
  const seen = new Set<string>()
  const recipes: EnvironmentRecipe[] = []
  for (const [index, raw] of value.entries()) {
    const invalid = (field: string, message: string) => diagnostics.push({ index, field, message })
    if (!isRecord(raw)) {
      invalid('recipe', 'Recipe entry must be a mapping.')
      continue
    }
    const id = textField(raw, 'id', 64)
    const name = textField(raw, 'name', 200)
    const create = textField(raw, 'create', 4096) ?? textField(raw, 'command', 4096)
    if (!id) {
      invalid('id', 'Recipe id is required.')
      continue
    }
    if (!RECIPE_ID_RE.test(id)) {
      invalid('id', `Invalid recipe id "${id}".`)
      continue
    }
    if (seen.has(id)) {
      invalid('id', `Duplicate recipe id "${id}".`)
      continue
    }
    if (!name) {
      invalid('name', `Recipe "${id}" is missing name.`)
      continue
    }
    if (!create) {
      invalid('create', `Recipe "${id}" is missing create.`)
      continue
    }
    const checkoutMode = textField(raw, 'checkoutMode', 32)
    if (checkoutMode !== undefined && checkoutMode !== 'orca-worktree' && checkoutMode !== 'provisioned-root') {
      invalid('checkoutMode', `Recipe "${id}" checkoutMode must be "orca-worktree" or "provisioned-root".`)
      continue
    }
    const destroyValue = textField(raw, 'destroy', 4096) ?? textField(raw, 'cleanup', 4096)
    const description = textField(raw, 'description', 2048)
    const suspend = textField(raw, 'suspend', 4096)
    const resume = textField(raw, 'resume', 4096)
    seen.add(id)
    recipes.push({
      id,
      name,
      create,
      ...(checkoutMode ? { checkoutMode } : {}),
      ...(description ? { description } : {}),
      ...(suspend ? { suspend } : {}),
      ...(resume ? { resume } : {}),
      ...(destroyValue && destroyValue !== 'none' ? { destroy: destroyValue } : {}),
      ...(destroyValue === 'none' ? { destroyDisabled: true } : {})
    })
  }
  return { recipes, diagnostics }
}

function defaultTabTrustText(setup: string | null, tabs: DefaultTabTemplate[]): string {
  const lineBreak = String.fromCharCode(10)
  const commands = tabs.flatMap((tab, index) => {
    const command = tab.command?.trim()
    if (!command) return []
    const label = tab.title ? ` ${tab.title}` : ''
    return [[`# defaultTabs[${index + 1}]${label}`, command].join(lineBreak)]
  })
  return [setup?.trim(), ...commands].filter((part): part is string => Boolean(part)).join(`${lineBreak}${lineBreak}`)
}

/** What a hooks file says; a file that doesn't parse or isn't a mapping says nothing, with a warning. */
function parseShared(file: HooksFile): SharedHooks {
  const shared: SharedHooks = {
    setup: null,
    archive: null,
    issueCommand: null,
    agentStartup: null,
    sharedDirectories: [],
    defaultTabs: [],
    environmentRecipes: [],
    environmentRecipeDiagnostics: [],
    warnings: []
  }
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
  shared.defaultTabs = parseDefaultTabs(document.defaultTabs, shared.warnings)
  const recipes = parseEnvironmentRecipes(document.environmentRecipes)
  shared.environmentRecipes = recipes.recipes
  shared.environmentRecipeDiagnostics = recipes.diagnostics
  for (const key of Object.keys(document)) {
    if (!KNOWN_KEYS.includes(key)) shared.warnings.push(`unrecognised key ${key}`)
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
 * The setup, archive and issue-command hooks that apply to a project, together with the shared
 * default terminal tabs and VM recipe declarations from its hooks file.
 */
export function effectiveHooks(file: HooksFile | null, settings: ProjectSettings, trusted: TrustedHashes): EffectiveRepoHooks {
  const shared = file ? parseShared(file) : null
  const local = (text: string) => (text.trim() === '' ? null : text.trim())
  const commandSource = settings.commandSource ?? (settings.setupScript.trim() ? 'local-only' : 'shared-only')
  const defaultTabsRunCommands = commandSource !== 'local-only'
  const tabCommands = shared?.defaultTabs.some((tab) => Boolean(tab.command?.trim())) === true
  const trustText = defaultTabsRunCommands && tabCommands
    ? defaultTabTrustText(shared?.setup ?? null, shared?.defaultTabs ?? [])
    : ''
  const defaultTabsTrust = trustText === '' ? null : {
    text: trustText,
    hash: hashScript(trustText),
    trusted: trusted.setup === hashScript(trustText),
    changed: trusted.setup !== undefined && trusted.setup !== hashScript(trustText)
  }
  const baseSetup = mergeScript(file, shared?.setup ?? null, local(settings.setupScript), settings.commandSource, trusted.setup)
  const setup = baseSetup?.shared && defaultTabsTrust
    ? { ...baseSetup, shared: defaultTabsTrust }
    : baseSetup
  return {
    file: file?.name ?? null,
    setup,
    archive: mergeScript(file, shared?.archive ?? null, local(settings.archiveScript), settings.commandSource, trusted.archive),
    issueCommand: mergeScript(file, shared?.issueCommand ?? null, local(settings.issueCommand ?? ''), settings.commandSource, trusted.issue),
    agentStartup: settings.agentStartup ?? shared?.agentStartup ?? 'start-immediately',
    sharedDirectories: shared?.sharedDirectories ?? [],
    warnings: shared?.warnings ?? [],
    ...(shared?.defaultTabs.length ? { defaultTabs: shared.defaultTabs } : {}),
    defaultTabsRunCommands,
    defaultTabsTrust,
    ...(shared?.environmentRecipes.length ? { environmentRecipes: shared.environmentRecipes } : {}),
    environmentRecipeDiagnostics: shared?.environmentRecipeDiagnostics ?? []
  }
}

/** The shared script text of each kind in `file`, for recording trust; empty when it has none. */
export function sharedScripts(file: HooksFile | null): Partial<Record<HookKind, string>> {
  const shared = file ? parseShared(file) : null
  const setupTrustText = shared ? defaultTabTrustText(shared.setup, shared.defaultTabs) : ''
  return {
    ...(setupTrustText ? { setup: setupTrustText } : {}),
    ...(shared?.archive ? { archive: shared.archive } : {}),
    ...(shared?.issueCommand ? { issue: shared.issueCommand } : {})
  }
}

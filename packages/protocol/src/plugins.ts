/** Where a plugin was found: shipped with Quirky, or installed by the user. */
export type PluginSource = 'builtin' | 'installed'

export type PluginState = 'inactive' | 'activating' | 'active' | 'failed' | 'disabled' | 'invalid'

export type PluginDiagnostic = { level: 'error' | 'warning'; message: string }

export type PluginInfo = {
  id: string
  name: string
  version: string
  description?: string
  source: PluginSource
  dir: string
  activation: 'lazy' | 'startup'
  dependencies: string[]
  state: PluginState
  /** Registry diagnostics, then the last activation error if the plugin failed. */
  diagnostics: PluginDiagnostic[]
}

export type ContributionStatus = 'effective' | 'overridden' | 'disabled' | 'rejected'

export type ContributionInfo = {
  id: string
  kind: string
  name: string
  /** The declaring plugin. */
  plugin: string
  override: boolean
  status: ContributionStatus
  overriddenBy?: string
  disabledBy?: 'user' | 'plugin' | 'owner'
  disablingPlugin?: string
  conflictWith?: string
  data: Record<string, unknown>
}

/** What a plugin's `activate` receives. */
export type PluginContext = {
  readonly pluginId: string
  readonly dir: string
  /** Writes to the daemon log, prefixed with the plugin ID. */
  log(message: string): void
  /** Registers the implementation of a contribution this plugin declares; throws for any other ID. */
  provide(contributionId: string, implementation: unknown): void
}

/** The shape a plugin's `main` module must export. */
export type PluginModule = {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** The parsed contents of a `quirky-plugin.json`. */
export type PluginManifest = {
  id: string
  name: string
  version: string
  description?: string
  /** Relative path inside the plugin directory. */
  main?: string
  /** Defaults to `lazy`. */
  activation?: 'lazy' | 'startup'
  dependencies?: string[]
  /** Contributions by kind; `id` is the name within the plugin's own namespace. */
  contributes?: Record<string, Array<{ id: string } & Record<string, unknown>>>
  /** Replacements for contributions in other plugins' namespaces; `id` is a full contribution ID. */
  overrides?: Array<{ id: string } & Record<string, unknown>>
  /** Full contribution IDs to switch off. */
  disables?: string[]
}

/** Plugin IDs starting with this prefix are reserved for built-in plugins. */
export const BUILTIN_PLUGIN_PREFIX = 'quirky.'

export const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
export const KIND_RE = /^[a-z]+(?:[.-][a-z]+)*$/
export const CONTRIBUTION_NAME_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/

export const MAX_PLUGIN_ID_LENGTH = 64
export const MAX_KIND_LENGTH = 64
export const MAX_CONTRIBUTION_NAME_LENGTH = 128

/** True for a valid plugin ID; a contribution ID (which contains `:`) is never one. */
export function isPluginId(value: string): boolean {
  return value.length <= MAX_PLUGIN_ID_LENGTH && PLUGIN_ID_RE.test(value)
}

/** True for a valid contribution kind such as `command` or `ui.panel`. */
export function isKind(value: string): boolean {
  return value.length <= MAX_KIND_LENGTH && KIND_RE.test(value)
}

/** True for a valid contribution name, the part after `/` in a contribution ID. */
export function isContributionName(value: string): boolean {
  return value.length <= MAX_CONTRIBUTION_NAME_LENGTH && CONTRIBUTION_NAME_RE.test(value)
}

/** Splits `<kind>:<pluginId>/<name>`; null unless every part is valid. */
export function parseContributionId(id: string): { kind: string; namespace: string; name: string } | null {
  const colon = id.indexOf(':')
  if (colon < 0) return null
  const slash = id.indexOf('/', colon + 1)
  if (slash < 0) return null
  const kind = id.slice(0, colon)
  const namespace = id.slice(colon + 1, slash)
  const name = id.slice(slash + 1)
  if (!isKind(kind) || !isPluginId(namespace) || !isContributionName(name)) return null
  return { kind, namespace, name }
}

/** Builds `<kind>:<namespace>/<name>`; throws an Error naming the first invalid part. */
export function formatContributionId(kind: string, namespace: string, name: string): string {
  if (!isKind(kind)) throw new Error(`invalid contribution kind: ${JSON.stringify(kind)}`)
  if (!isPluginId(namespace)) throw new Error(`invalid plugin ID: ${JSON.stringify(namespace)}`)
  if (!isContributionName(name)) throw new Error(`invalid contribution name: ${JSON.stringify(name)}`)
  return `${kind}:${namespace}/${name}`
}

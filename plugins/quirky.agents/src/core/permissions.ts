import { EMPTY_CONFIG, type AgentConfig, type AgentEntry, type PermissionMode, type PermissionSummary } from './types'

type Env = Record<string, string>

/** A refused permission change; the message is shown to the user as written. */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}

/** The arguments a launch uses: the saved override, else the Yolo default. */
export function effectiveArgs(entry: AgentEntry, config: AgentConfig): string {
  return config.args ?? entry.yolo ?? ''
}

/** The environment a launch adds for permissions: the saved override, else the Yolo default. */
export function effectiveEnv(entry: AgentEntry, config: AgentConfig): Env {
  return config.env ?? entry.yoloEnv ?? {}
}

function hasArgsControl(entry: AgentEntry): boolean {
  return entry.yolo !== null
}

function hasEnvControl(entry: AgentEntry): boolean {
  return entry.yoloEnv !== null
}

function hasControl(entry: AgentEntry): boolean {
  return hasArgsControl(entry) || hasEnvControl(entry)
}

function sameEnv(left: Env | null | undefined, right: Env | null | undefined): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([name, value]) => right?.[name] === value)
}

type Resolved = PermissionMode | 'custom'

function argsMode(entry: AgentEntry, config: AgentConfig): Resolved {
  const args = effectiveArgs(entry, config).trim()
  if (!args) return 'manual'
  if (args === entry.yolo) return 'yolo'
  return entry.auto !== null && args === entry.auto ? 'auto' : 'custom'
}

function envMode(entry: AgentEntry, config: AgentConfig): Resolved {
  const env = effectiveEnv(entry, config)
  if (sameEnv(env, {})) return 'manual'
  return sameEnv(env, entry.yoloEnv) ? 'yolo' : 'custom'
}

/**
 * The permission mode a launch of this agent resolves to. Null when the agent has no permission
 * control; `custom` for arguments or environment that are not one of the presets, including a mix
 * of an argument preset and a different environment preset.
 */
export function agentPermissionMode(entry: AgentEntry, config: AgentConfig): Resolved | null {
  const modes: Resolved[] = []
  if (hasArgsControl(entry)) modes.push(argsMode(entry, config))
  if (hasEnvControl(entry)) modes.push(envMode(entry, config))
  if (modes.length === 0) return null
  return modes.every((mode) => mode === modes[0]) ? modes[0] : 'custom'
}

function combine(modes: PermissionMode[]): PermissionSummary {
  const distinct = new Set(modes)
  return distinct.size > 1 ? 'mixed' : (modes[0] ?? 'manual')
}

// custom rows are left alone by every bulk change, so they stay out of the summary
function presetRows(
  entries: AgentEntry[],
  configs: Map<string, AgentConfig>
): { entry: AgentEntry; mode: PermissionMode }[] {
  const rows: { entry: AgentEntry; mode: PermissionMode }[] = []
  for (const entry of entries) {
    const mode = agentPermissionMode(entry, configs.get(entry.id) ?? EMPTY_CONFIG)
    if (mode !== null && mode !== 'custom') rows.push({ entry, mode })
  }
  return rows
}

/**
 * The one mode that describes all preset agents (`auto` when every Auto-capable preset agent is on
 * Auto), and the combined mode of the preset agents Auto does not cover, so a view can say what
 * those still use. `nonAuto` is `mixed` when no preset row is left to describe.
 */
export function permissionSummary(
  entries: AgentEntry[],
  configs: Map<string, AgentConfig>
): { summary: PermissionSummary; nonAuto: 'manual' | 'yolo' | 'mixed' } {
  const rows = presetRows(entries, configs)

  const autoCapable = rows.filter(({ entry }) => entry.auto !== null)
  const summary =
    autoCapable.length > 0 && autoCapable.every(({ mode }) => mode === 'auto')
      ? 'auto'
      : combine(rows.map(({ mode }) => mode))

  const nonAutoModes = new Set(rows.filter(({ entry }) => entry.auto === null).map(({ mode }) => mode))
  const nonAuto = nonAutoModes.size !== 1 ? 'mixed' : nonAutoModes.has('yolo') ? 'yolo' : 'manual'

  return { summary, nonAuto }
}

type Stored = { args: string | null; env: Env | null }

function storedFor(entry: AgentEntry, config: AgentConfig, mode: PermissionMode): Stored {
  let args = config.args
  let env = config.env
  if (hasArgsControl(entry)) args = mode === 'yolo' ? entry.yolo : mode === 'auto' ? entry.auto : ''
  if (hasEnvControl(entry)) env = mode === 'yolo' ? { ...entry.yoloEnv } : {}
  return { args, env }
}

function sameStored(config: AgentConfig, next: Stored): boolean {
  if (config.args !== next.args) return false
  if (config.env === null || next.env === null) return config.env === next.env
  return sameEnv(config.env, next.env)
}

/**
 * Sets the permission mode of one agent or of every agent that has one, returning the new configs
 * and the agents whose stored arguments or environment changed (empty for a repeat). A bulk change
 * rewrites only preset rows, and bulk Auto only Auto-capable agents. A change to one agent throws
 * `PermissionError` when it cannot apply: no permission control, no Auto mode, or custom values
 * without `replaceCustom`. The input configs are not modified.
 */
export function applyPermissionMode(
  entries: AgentEntry[],
  configs: Map<string, AgentConfig>,
  options: { mode: PermissionMode; agent?: string; replaceCustom?: boolean }
): { configs: Map<string, AgentConfig>; changed: string[] } {
  const { mode, agent, replaceCustom } = options
  let targets: AgentEntry[]

  if (agent !== undefined) {
    const entry = entries.find((candidate) => candidate.id === agent)
    if (!entry) throw new PermissionError(`unknown agent: ${agent}`)
    if (!hasControl(entry)) throw new PermissionError(`${agent} has no permission modes`)
    if (mode === 'auto' && entry.auto === null) throw new PermissionError(`${agent} has no Auto mode`)
    const current = agentPermissionMode(entry, configs.get(agent) ?? EMPTY_CONFIG)
    if (current === 'custom' && !replaceCustom) {
      throw new PermissionError(`${agent} has custom arguments; pass --replace-custom to replace them`)
    }
    targets = [entry]
  } else {
    targets = presetRows(entries, configs)
      .map(({ entry }) => entry)
      .filter((entry) => mode !== 'auto' || entry.auto !== null)
  }

  const next = new Map(configs)
  const changed: string[] = []
  for (const entry of targets) {
    const config = configs.get(entry.id) ?? EMPTY_CONFIG
    const stored = storedFor(entry, config, mode)
    if (sameStored(config, stored)) continue
    next.set(entry.id, { ...config, ...stored })
    changed.push(entry.id)
  }
  return { configs: next, changed }
}

import {
  BUILTIN_PLUGIN_PREFIX,
  checkSchemaDeclaration,
  flagNameOf,
  isContributionName,
  isPluginId,
  MAX_JOB_DURATION_MS,
  MIN_JOB_INTERVAL_MS,
  parseDuration,
  RESERVED_FLAG_NAMES,
} from '@quirky/protocol'
import { checkUiKindEntry, isUiKind } from './ui-kinds'

type Entry = Record<string, unknown>

const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  method: ['description', 'params', 'result', 'readOnly', 'destructive', 'confirm', 'describe', 'connection'],
  event: ['description', 'data'],
  job: ['description', 'interval', 'initialDelay', 'timeout'],
  'launch-hook': ['description', 'agents'],
  'cli-command': ['description', 'words', 'summary', 'method', 'positionals', 'flags', 'methods'],
}

/** A single CLI word: a group, a command word or an alias. */
export const CLI_WORD_RE = /^[a-z][a-z0-9-]*$/

const FLAG_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const FLAG_TYPES = ['string', 'integer', 'number', 'boolean', 'json']

/** The CLI group word of a plugin: its ID without the `quirky.` prefix built-ins carry. */
export function cliGroupWord(pluginId: string): string {
  return pluginId.startsWith(BUILTIN_PLUGIN_PREFIX) ? pluginId.slice(BUILTIN_PLUGIN_PREFIX.length) : pluginId
}

/**
 * The words a `cli-command` runs under, relative to its group. `words` defaults to the
 * contribution name, which is the last segment of an override's full ID.
 */
export function effectiveCliWords(id: string, words: unknown): string {
  return typeof words === 'string' ? words : id.slice(id.lastIndexOf('/') + 1)
}

/** True for a method name in the plugin's own namespace or a full `<pluginId>/<name>`. */
export function isMethodReference(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const slash = value.indexOf('/')
  if (slash < 0) return isContributionName(value)
  return isPluginId(value.slice(0, slash)) && isContributionName(value.slice(slash + 1))
}

const DURATION_HELP = 'must be a duration such as 30s, 5m or 2h'

function checkDuration(
  label: string,
  entry: Entry,
  field: string,
  bounds: { min: number; message: string },
  errors: string[],
): void {
  const value = entry[field]
  const ms = typeof value === 'string' ? parseDuration(value) : null
  if (ms === null) errors.push(`${label}: ${field} ${DURATION_HELP}`)
  else if (ms < bounds.min || ms > MAX_JOB_DURATION_MS) errors.push(`${label}: ${field} ${bounds.message}`)
}

function checkAgents(label: string, agents: unknown, errors: string[]): void {
  const valid =
    Array.isArray(agents) && agents.length > 0 && agents.every((item) => typeof item === 'string' && item !== '')
  if (!valid) errors.push(`${label}: agents must be a list of agent names`)
}

function checkSchemaField(label: string, entry: Entry, field: string, options: { object?: boolean }, errors: string[]): string[] {
  if (entry[field] === undefined) return []
  const problems = checkSchemaDeclaration(entry[field], field, options)
  for (const problem of problems) errors.push(`${label}: ${problem}`)
  return problems
}

function checkFlagCollisions(label: string, params: unknown, errors: string[]): void {
  const properties = (params as { properties?: Record<string, unknown> }).properties
  if (properties === undefined) return
  const owners = new Map<string, string>()
  for (const name of Object.keys(properties)) {
    const flag = flagNameOf(name)
    const first = owners.get(flag)
    if (first === undefined) owners.set(flag, name)
    else errors.push(`${label}: params ${first} and ${name} both map to --${flag}`)
  }
}

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkMethodFlags(label: string, entry: Entry, errors: string[]): void {
  for (const field of ['readOnly', 'destructive', 'connection']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'boolean') errors.push(`${label}: ${field} must be a boolean`)
  }
  const destructive = entry.destructive === true
  if (entry.confirm !== undefined) {
    if (typeof entry.confirm !== 'string' || entry.confirm === '') errors.push(`${label}: confirm must be a non-empty string`)
    else if (!destructive) errors.push(`${label}: confirm needs destructive: true`)
  } else if (destructive) {
    errors.push(`${label}: confirm is required when destructive is true`)
  }
  if (entry.describe !== undefined) {
    if (!isMethodReference(entry.describe)) errors.push(`${label}: describe must be a method name or <pluginId>/<name>`)
    else if (!destructive) errors.push(`${label}: describe needs destructive: true`)
  }
}

function checkPositionals(label: string, positionals: unknown, errors: string[]): void {
  if (!Array.isArray(positionals)) {
    errors.push(`${label}: positionals must be a list`)
    return
  }
  const names = new Set<string>()
  positionals.forEach((item, index) => {
    const at = `${label}: positionals[${index}]`
    if (!isRecord(item)) {
      errors.push(`${at} must be an object`)
      return
    }
    for (const field of Object.keys(item)) {
      if (!['name', 'description', 'required', 'param'].includes(field)) errors.push(`${at} has unknown field \`${field}\``)
    }
    if (typeof item.name !== 'string' || !CLI_WORD_RE.test(item.name)) errors.push(`${at}.name must be a lowercase word`)
    else if (names.has(item.name)) errors.push(`${at} repeats the name '${item.name}'`)
    else names.add(item.name)
    if (typeof item.description !== 'string') errors.push(`${at}.description must be a string`)
    if (item.required !== undefined && typeof item.required !== 'boolean') errors.push(`${at}.required must be a boolean`)
    if (item.param !== undefined && (typeof item.param !== 'string' || item.param === '')) {
      errors.push(`${at}.param must be a non-empty string`)
    }
  })
}

function checkFlagSpec(label: string, name: string, spec: unknown, errors: string[]): void {
  const at = `${label}: flag '${name}'`
  if (!FLAG_NAME_RE.test(name)) errors.push(`${at} must be a kebab-case name`)
  else if ((RESERVED_FLAG_NAMES as readonly string[]).includes(name)) errors.push(`${at} is reserved`)
  if (!isRecord(spec)) {
    errors.push(`${at} must be an object`)
    return
  }
  for (const field of Object.keys(spec)) {
    if (!['type', 'description', 'required', 'repeatable', 'enum', 'param'].includes(field)) {
      errors.push(`${at} has unknown field \`${field}\``)
    }
  }
  if (typeof spec.type !== 'string' || !FLAG_TYPES.includes(spec.type)) {
    errors.push(`${at} type must be one of ${FLAG_TYPES.join(', ')}`)
  }
  if (typeof spec.description !== 'string') errors.push(`${at} description must be a string`)
  for (const field of ['required', 'repeatable']) {
    if (spec[field] !== undefined && typeof spec[field] !== 'boolean') errors.push(`${at} ${field} must be a boolean`)
  }
  if (spec.enum !== undefined) {
    const valid =
      Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.every((v) => typeof v === 'string' || typeof v === 'number')
    if (!valid) errors.push(`${at} enum must be a non-empty list of strings or numbers`)
  }
  if (spec.param !== undefined && (typeof spec.param !== 'string' || spec.param === '')) {
    errors.push(`${at} param must be a non-empty string`)
  }
}

function checkCliCommand(label: string, entry: Entry, errors: string[]): void {
  if (entry.summary === undefined) errors.push(`${label}: summary is required`)
  else if (typeof entry.summary !== 'string' || entry.summary === '') errors.push(`${label}: summary must be a non-empty string`)

  if (entry.words !== undefined && typeof entry.words !== 'string') errors.push(`${label}: words must be a string`)
  else {
    const words = effectiveCliWords(String(entry.id), entry.words)
    if (words !== '' && !words.split(' ').every((word) => CLI_WORD_RE.test(word))) {
      errors.push(`${label}: words '${words}' must be space-separated lowercase words`)
    }
  }
  if (entry.method !== undefined && !isMethodReference(entry.method)) {
    errors.push(`${label}: method must be a method name or <pluginId>/<name>`)
  }
  if (entry.methods !== undefined) {
    const valid = Array.isArray(entry.methods) && entry.methods.every((name) => typeof name === 'string' && name !== '')
    if (!valid) errors.push(`${label}: methods must be a list of method names`)
  }
  if (entry.positionals !== undefined) checkPositionals(label, entry.positionals, errors)
  if (entry.flags !== undefined) {
    if (!isRecord(entry.flags)) errors.push(`${label}: flags must be an object`)
    else for (const [name, spec] of Object.entries(entry.flags)) checkFlagSpec(label, name, spec, errors)
  }
}

/**
 * Checks the fields of a contribution of one of the daemon's own kinds (`method`, `event`, `job`,
 * `launch-hook`, `cli-command`) or of a UI kind (delegated to `ui-kinds.ts`) and appends one message per problem
 * to `errors`. Other kinds are left alone.
 * `label` prefixes every message and names the entry, e.g. `job tick` or `override job:acme.poll/tick`.
 */
export function checkKindEntry(kind: string, label: string, entry: Entry, errors: string[]): void {
  if (isUiKind(kind)) {
    checkUiKindEntry(kind, label, entry, errors)
    return
  }
  if (!Object.hasOwn(ALLOWED_FIELDS, kind)) return
  const allowed = ALLOWED_FIELDS[kind]
  for (const field of Object.keys(entry)) {
    if (field !== 'id' && !allowed.includes(field)) errors.push(`${label}: unknown field \`${field}\``)
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    errors.push(`${label}: description must be a string`)
  }
  if (kind === 'method') {
    const problems = checkSchemaField(label, entry, 'params', { object: true }, errors)
    if (entry.params !== undefined && problems.length === 0) checkFlagCollisions(label, entry.params, errors)
    checkSchemaField(label, entry, 'result', {}, errors)
    checkMethodFlags(label, entry, errors)
  }
  if (kind === 'event') checkSchemaField(label, entry, 'data', {}, errors)
  if (kind === 'job') {
    if (entry.interval === undefined) errors.push(`${label}: interval is required`)
    else checkDuration(label, entry, 'interval', { min: MIN_JOB_INTERVAL_MS, message: 'must be between 1s and 24h' }, errors)
    if (entry.initialDelay !== undefined) {
      checkDuration(label, entry, 'initialDelay', { min: 0, message: 'must be between 0s and 24h' }, errors)
    }
    if (entry.timeout !== undefined) {
      checkDuration(label, entry, 'timeout', { min: MIN_JOB_INTERVAL_MS, message: 'must be between 1s and 24h' }, errors)
    }
  }
  if (kind === 'cli-command') checkCliCommand(label, entry, errors)
  if (kind === 'launch-hook' && entry.agents !== undefined) checkAgents(label, entry.agents, errors)
}

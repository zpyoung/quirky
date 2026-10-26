import { checkSchemaDeclaration, flagNameOf, MAX_JOB_DURATION_MS, MIN_JOB_INTERVAL_MS, parseDuration } from '@quirky/protocol'
import { checkUiKindEntry, isUiKind } from './ui-kinds'

type Entry = Record<string, unknown>

const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  method: ['description', 'params', 'result'],
  event: ['description', 'data'],
  job: ['description', 'interval', 'initialDelay', 'timeout'],
  'launch-hook': ['description', 'agents'],
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

/**
 * Checks the fields of a contribution of one of the daemon's own kinds (`method`, `event`, `job`,
 * `launch-hook`) or of a UI kind (delegated to `ui-kinds.ts`) and appends one message per problem
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
  if (kind === 'launch-hook' && entry.agents !== undefined) checkAgents(label, entry.agents, errors)
}

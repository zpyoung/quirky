/**
 * Parsing and validation of detection rule files. A file is accepted whole or not at all: the
 * first problem found invalidates it and is reported with the rule id and field, so a person
 * editing a rule file can find the line to fix.
 */
import { unsafePatternReason } from './safety'
import type { Matcher, Rule, RuleFile } from './types'

export type { BlockedKind, Evaluation, EvaluateInput, IgnoredSource, LineMatch, Matcher, Origin, Rule, RuleFile, RuleListing, RuleState, Verdict } from './types'

export type ParseResult = { ok: true; file: RuleFile } | { ok: false; reason: string }

const RULE_FIELDS = new Set(['id', 'why', 'state', 'kind', 'region', 'lastLines', 'all', 'none', 'quietMs'])
const STATES = ['working', 'blocked', 'idle']
const KINDS = ['approval', 'question']
const REGIONS = ['title', 'screen']
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

class Invalid extends Error {}

const fail = (where: string, problem: string): never => {
  throw new Invalid(where ? `${where}: ${problem}` : problem)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const quote = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value) : JSON.stringify(value) ?? String(value))

function checkInteger(where: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(where, `must be an integer from ${min} to ${max} (got ${quote(value)})`)
  return value as number
}

function checkOneOf<T extends string>(where: string, value: unknown, allowed: readonly string[]): T {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(where, `must be ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]} (got ${quote(value)})`)
  return value as T
}

function checkMatcher(where: string, value: unknown): Matcher {
  if (!isObject(value)) return fail(where, 'must be an object with regex or contains')
  const keys = Object.keys(value)
  if ('contains' in value) {
    for (const key of keys) if (key !== 'contains') fail(where, `${key} is not allowed with contains`)
    if (typeof value.contains !== 'string' || value.contains === '') fail(`${where}.contains`, 'must be a non-empty string')
    return { contains: value.contains as string }
  }
  if (!('regex' in value)) return fail(where, 'needs regex or contains')
  for (const key of keys) if (key !== 'regex' && key !== 'ignoreCase') fail(where, `${key} is not a known field`)
  if (typeof value.regex !== 'string' || value.regex === '') fail(`${where}.regex`, 'must be a non-empty string')
  const unsafe = unsafePatternReason(value.regex as string)
  if (unsafe) fail(`${where}.regex`, `pattern ${unsafe}`)
  if ('ignoreCase' in value && typeof value.ignoreCase !== 'boolean') fail(`${where}.ignoreCase`, 'must be true or false')
  return value.ignoreCase === undefined ? { regex: value.regex as string } : { regex: value.regex as string, ignoreCase: value.ignoreCase as boolean }
}

function checkMatchers(rule: string, field: 'all' | 'none', value: unknown): Matcher[] {
  if (!Array.isArray(value)) return fail(`${rule}: ${field}`, 'must be an array of matchers')
  return value.map((entry, index) => checkMatcher(`${rule}: ${field}[${index}]`, entry))
}

function checkRule(value: unknown, index: number, seen: Set<string>): Rule {
  if (!isObject(value)) return fail(`rules[${index}]`, 'must be an object')
  const id = value.id
  if (typeof id !== 'string' || !ID.test(id)) fail(`rules[${index}].id`, `must be 1 to 64 characters of a-z, 0-9 and -, starting with a letter or digit (got ${quote(id)})`)
  const rule = `rule ${JSON.stringify(id)}`
  if (seen.has(id as string)) fail(`${rule}: id`, 'duplicate of an earlier rule')
  seen.add(id as string)
  for (const key of Object.keys(value)) if (!RULE_FIELDS.has(key)) fail(`${rule}: ${key}`, 'is not a known field')

  if (value.why !== undefined && typeof value.why !== 'string') fail(`${rule}: why`, 'must be a string')
  const state = checkOneOf<Rule['state']>(`${rule}: state`, value.state, STATES)
  const region = checkOneOf<Rule['region']>(`${rule}: region`, value.region, REGIONS)
  const out: Rule = { id: id as string, state, region }
  if (value.why !== undefined) out.why = value.why as string

  if (value.kind !== undefined) {
    if (state !== 'blocked') fail(`${rule}: kind`, 'is only allowed on a blocked rule')
    out.kind = checkOneOf<NonNullable<Rule['kind']>>(`${rule}: kind`, value.kind, KINDS)
  }
  if (value.lastLines !== undefined) {
    if (region !== 'screen') fail(`${rule}: lastLines`, 'is only allowed on a screen rule')
    out.lastLines = checkInteger(`${rule}: lastLines`, value.lastLines, 1, 200)
  }
  if (value.quietMs !== undefined) out.quietMs = checkInteger(`${rule}: quietMs`, value.quietMs, 0, 10_000)

  if (value.all !== undefined) out.all = checkMatchers(rule, 'all', value.all)
  if (value.none !== undefined) out.none = checkMatchers(rule, 'none', value.none)
  if (!out.all?.length && !out.none?.length) fail(`${rule}: all`, 'needs at least one matcher in all or none')
  return out
}

function checkFile(value: unknown, expectedAgent: string, agentRequired: boolean): RuleFile {
  if (!isObject(value)) return fail('', 'a rule file must be an object')
  for (const key of Object.keys(value)) if (key !== 'agent' && key !== 'description' && key !== 'rules') fail(key, 'is not a known field')
  if (value.agent === undefined ? agentRequired : value.agent !== expectedAgent) {
    return fail('agent', value.agent === undefined ? 'is required' : `is ${quote(value.agent)} but this rule set is for ${quote(expectedAgent)}`)
  }
  if (value.description !== undefined && typeof value.description !== 'string') fail('description', 'must be a string')
  if (!Array.isArray(value.rules)) return fail('rules', 'must be an array of rules')
  const seen = new Set<string>()
  const rules = value.rules.map((entry, index) => checkRule(entry, index, seen))
  return value.description === undefined ? { agent: expectedAgent, rules } : { agent: expectedAgent, description: value.description as string, rules }
}

function attempt(check: () => RuleFile): ParseResult {
  try {
    return { ok: true, file: check() }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.message }
    throw error
  }
}

/** Parses a rule file's text for `expectedAgent`; a file naming another agent is invalid. */
export function parseRuleFile(text: string, expectedAgent: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  return attempt(() => checkFile(value, expectedAgent, true))
}

/** Validates an `agent-rules` contribution's data for the agent it is named after; `agent` may be omitted there. */
export function parseRuleData(data: Record<string, unknown>, expectedAgent: string): ParseResult {
  return attempt(() => checkFile(data, expectedAgent, false))
}

import * as ts from 'typescript'
import type { CheckResult, Evidence, Inventory, RatchetResult, StaticCheckId, StaticRatchet } from './contracts'
import { checkHostTokens, checkPlugin, sharedTokenEvidence } from './tokens'

const staticChecks: Record<StaticCheckId, true> = {
  'compatibility-tokens': true, loading: true, empty: true, error: true, commands: true,
}

type Validation = { errors: Evidence[]; entries: Array<[string, StaticCheckId[]]> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configError(code: string, message: string): Evidence {
  return { code, message }
}

function assertUniquePluginKeys(text: string): void {
  const source = ts.parseJsonText('ui-scoreboard-ratchet.json', text)
  const statement = source.statements[0]
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) return

  const seen = new Set<string>()
  for (const property of statement.expression.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue
    const key = property.name.text
    if (seen.has(key)) throw new Error(`Duplicate ratchet plugin key: ${key}`)
    seen.add(key)
  }
}

/** Parses strict JSON enrollment; throws for malformed, duplicate, empty, or unsupported entries. */
export function parseRatchetConfig(text: string): StaticRatchet {
  assertUniquePluginKeys(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Malformed ratchet JSON')
  }
  if (!isRecord(value)) throw new Error('Ratchet config must be a JSON object')

  const result = Object.create(null) as Record<string, StaticCheckId[]>
  for (const [pluginId, rawChecks] of Object.entries(value)) {
    if (pluginId.length === 0) throw new Error('Ratchet plugin keys must be nonempty')
    if (!Array.isArray(rawChecks) || rawChecks.length === 0) throw new Error(`Ratchet checks for ${pluginId} must be a nonempty array`)
    const checks: StaticCheckId[] = []
    const seen = new Set<string>()
    for (const rawCheck of rawChecks) {
      if (typeof rawCheck !== 'string' || !Object.prototype.hasOwnProperty.call(staticChecks, rawCheck)) throw new Error(`Unsupported ratchet check for ${pluginId}: ${String(rawCheck)}`)
      if (seen.has(rawCheck)) throw new Error(`Duplicate ratchet check for ${pluginId}: ${rawCheck}`)
      seen.add(rawCheck)
      checks.push(rawCheck as StaticCheckId)
    }
    Object.defineProperty(result, pluginId, { value: checks, enumerable: true, configurable: true, writable: true })
  }
  return result
}

function validateEnrollment(inventory: Inventory, enrollment: unknown): Validation {
  const errors: Evidence[] = []
  const entries: Array<[string, StaticCheckId[]]> = []
  if (!isRecord(enrollment)) {
    return { errors: [configError('invalid-ratchet-config', 'Ratchet enrollment must be an object')], entries }
  }

  const pluginIds = new Set(inventory.plugins.map((plugin) => plugin.id))
  for (const [pluginId, rawChecks] of Object.entries(enrollment)) {
    if (pluginId !== 'host' && !pluginIds.has(pluginId)) {
      errors.push(configError('unknown-ratchet-plugin', `Ratchet enrollment references unknown or deleted plugin ${pluginId}`))
      continue
    }
    if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
      errors.push(configError('invalid-ratchet-checks', `Ratchet checks for ${pluginId} must be a nonempty array`))
      continue
    }
    const checks: StaticCheckId[] = []
    const seen = new Set<string>()
    for (const rawCheck of rawChecks) {
      if (typeof rawCheck !== 'string' || !Object.prototype.hasOwnProperty.call(staticChecks, rawCheck)) {
        errors.push(configError('unsupported-ratchet-check', `Ratchet enrollment for ${pluginId} has unsupported check ${String(rawCheck)}`))
        continue
      }
      if (seen.has(rawCheck)) {
        errors.push(configError('duplicate-ratchet-check', `Ratchet enrollment for ${pluginId} repeats check ${rawCheck}`))
        continue
      }
      seen.add(rawCheck)
      checks.push(rawCheck as StaticCheckId)
    }
    entries.push([pluginId, checks])
  }
  return { errors, entries }
}

function checkFor(inventory: Inventory, pluginId: string, checkId: StaticCheckId): CheckResult | undefined {
  if (pluginId === 'host') {
    const hostCheck = checkHostTokens(inventory)
    return hostCheck.id === checkId ? hostCheck : undefined
  }
  return checkPlugin(inventory, pluginId).find((check) => check.id === checkId)
}

/** Returns exit 2 for invalid inventory/enrollment, 1 for failed enrolled checks, otherwise 0. */
export function checkRatchet(inventory: Inventory, enrollment: StaticRatchet): RatchetResult {
  const failures = [...inventory.failures]
  const { errors, entries } = validateEnrollment(inventory, enrollment)
  failures.push(...errors)
  if (failures.length > 0) return { exitCode: 2, failures }

  const regressions: Evidence[] = []
  for (const [pluginId, checks] of entries) {
    for (const checkId of checks) {
      const result = checkFor(inventory, pluginId, checkId)
      if (!result) {
        regressions.push(configError('unavailable-ratchet-check', `Ratchet check ${pluginId}/${checkId} is unavailable`))
        continue
      }
      if (result.status === 'pass') continue
      const evidence = result.evidence.length > 0
        ? result.evidence
        : [{ code: result.reason, message: result.reason }]
      for (const item of evidence) {
        const details = item.sharedEvidence === 'compatibility-tokens' && !item.source
          ? sharedTokenEvidence(inventory)
          : [item]
        for (const detail of details) {
          regressions.push({
            ...detail,
            message: `${pluginId} / ${checkId}: ${detail.message}`,
          })
        }
      }
    }
  }
  return { exitCode: regressions.length > 0 ? 1 : 0, failures: regressions }
}

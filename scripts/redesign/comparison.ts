#!/usr/bin/env bun
/**
 * Writes a feature's `comparison.md` from its `ComparisonData`.
 *
 *   bun scripts/redesign/comparison.ts <spec-folder> <comparison-data.json>
 *
 * Prints `{"written": "<path>"}` on stdout. Exit 0 on success, 2 on bad arguments or invalid data
 * (the message names the first bad field).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Capability, ComparisonData, GateReport, GateRow, GoalOutcome } from './contracts'

const IMAGE_WIDTH = 420

const GOAL_TAGS = ['fixture', 'real-app']
const GOAL_RESULTS = ['replayed', 'failed', 'cut', 'not-replayed']
const GATE_RESULTS = ['clears', 'fails', 'new', 'removed']
const DECISIONS = ['kept', 'moved', 'cut']

type Fields = Record<string, unknown>

function fail(path: string, expectation: string): never {
  throw new Error(`${path}: ${expectation}`)
}

function asRecord(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object')
  return value as Fields
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  return value
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'expected a non-empty string')
  return value
}

function asOneOf(value: unknown, path: string, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(path, `expected one of ${allowed.join(', ')}`)
  return value
}

function asPathOrNull(value: unknown, path: string): string | null {
  if (value === null) return null
  return asString(value, path)
}

function asScorePair(value: unknown, path: string): GateRow['before'] {
  if (value === null) return null
  const fields = asRecord(value, path)
  const score = (theme: 'dark' | 'light') => {
    const entry = fields[theme]
    if (entry !== null && typeof entry !== 'number') fail(`${path}.${theme}`, 'expected a number or null')
    return entry
  }
  return { dark: score('dark'), light: score('light') }
}

function validateGoal(value: unknown, path: string): GoalOutcome {
  const fields = asRecord(value, path)
  const result = asOneOf(fields.result, `${path}.result`, GOAL_RESULTS) as GoalOutcome['result']
  const goal: GoalOutcome = {
    id: asString(fields.id, `${path}.id`),
    title: asString(fields.title, `${path}.title`),
    tag: asOneOf(fields.tag, `${path}.tag`, GOAL_TAGS) as GoalOutcome['tag'],
    before: asPathOrNull(fields.before, `${path}.before`),
    after: asPathOrNull(fields.after, `${path}.after`),
    result
  }
  if (result !== 'replayed') goal.reason = asString(fields.reason, `${path}.reason`)
  return goal
}

function validateGate(value: unknown): GateReport {
  const fields = asRecord(value, 'gate')
  if (typeof fields.passed !== 'boolean') fail('gate.passed', 'expected a boolean')
  if (typeof fields.floor !== 'number') fail('gate.floor', 'expected a number')
  const rows = asArray(fields.rows, 'gate.rows').map((raw, index): GateRow => {
    const path = `gate.rows[${index}]`
    const row = asRecord(raw, path)
    const reasons = asArray(row.reasons, `${path}.reasons`).map((reason, at) => asString(reason, `${path}.reasons[${at}]`))
    return {
      id: asString(row.id, `${path}.id`),
      before: asScorePair(row.before, `${path}.before`),
      after: asScorePair(row.after, `${path}.after`),
      result: asOneOf(row.result, `${path}.result`, GATE_RESULTS) as GateRow['result'],
      reasons
    }
  })
  return { passed: fields.passed, floor: fields.floor, rows }
}

function validateCapability(value: unknown, path: string): Capability {
  const fields = asRecord(value, path)
  const decision = asOneOf(fields.decision, `${path}.decision`, DECISIONS) as Capability['decision']
  const capability: Capability = { name: asString(fields.name, `${path}.name`), decision }
  if (decision === 'moved') capability.where = asString(fields.where, `${path}.where`)
  if (decision === 'cut') capability.reason = asString(fields.reason, `${path}.reason`)
  return capability
}

/** Checks untrusted JSON against `ComparisonData`; throws an Error whose message starts with the first bad field's path. */
export function validateComparisonData(raw: unknown): ComparisonData {
  const fields = asRecord(raw, 'data')
  return {
    feature: asString(fields.feature, 'feature'),
    failures: asArray(fields.failures, 'failures').map((failure, index) => asString(failure, `failures[${index}]`)),
    goals: asArray(fields.goals, 'goals').map((goal, index) => validateGoal(goal, `goals[${index}]`)),
    gate: validateGate(fields.gate),
    capabilities: asArray(fields.capabilities, 'capabilities').map((capability, index) =>
      validateCapability(capability, `capabilities[${index}]`)
    )
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function image(path: string | null): string {
  if (path === null) return 'none'
  const src = path.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\|/g, '&#124;')
  return `<img src="${src}" width="${IMAGE_WIDTH}">`
}

function goalResult(goal: GoalOutcome): string {
  switch (goal.result) {
    case 'replayed':
      return '✓ replayed'
    case 'failed':
      return `✗ failed: ${goal.reason}`
    case 'cut':
      return `cut: ${goal.reason}`
    case 'not-replayed':
      return `not replayed: ${goal.reason}`
  }
}

function scorePair(pair: GateRow['before']): string {
  if (pair === null) return 'none'
  return `${pair.dark ?? 'none'} / ${pair.light ?? 'none'}`
}

function gateResult(row: GateRow): string {
  switch (row.result) {
    case 'clears':
    case 'new':
      return '✓ clears'
    case 'fails':
      return `✗ ${row.reasons.join('; ')}`
    case 'removed':
      return 'removed'
  }
}

function capabilityDecision(capability: Capability): string {
  switch (capability.decision) {
    case 'kept':
      return 'kept'
    case 'moved':
      return `moved to ${capability.where}`
    case 'cut':
      return `cut: ${capability.reason}`
  }
}

/**
 * Renders the before/after page. "Still failing" comes first when there are failures so the PR's
 * first link opens on it. Pure: the data is assumed valid (see `validateComparisonData`).
 */
export function renderComparison(data: ComparisonData): string {
  const lines: string[] = [`# ${data.feature}: before and after`, '']

  if (data.failures.length > 0) {
    lines.push('## Still failing', '', ...data.failures.map((failure) => `- ${failure}`), '')
  }

  lines.push('## Goals', '', '| Goal | Before | After | Result |', '| --- | --- | --- | --- |')
  for (const goal of data.goals) {
    lines.push(`| ${cell(goal.title)} | ${image(goal.before)} | ${image(goal.after)} | ${cell(goalResult(goal))} |`)
  }

  lines.push('', '## Scores', '', '| Surface | Before (dark / light) | After (dark / light) | Result |', '| --- | --- | --- | --- |')
  for (const row of data.gate.rows) {
    const before = row.before === null ? 'none, new' : scorePair(row.before)
    const after = row.result === 'removed' ? 'removed' : scorePair(row.after)
    lines.push(`| ${cell(row.id)} | ${before} | ${after} | ${cell(gateResult(row))} |`)
  }

  lines.push('', '## Capabilities', '', '| Capability | Decision |', '| --- | --- |')
  for (const capability of data.capabilities) {
    lines.push(`| ${cell(capability.name)} | ${cell(capabilityDecision(capability))} |`)
  }

  return `${lines.join('\n')}\n`
}

/** Reads `dataPath`, validates it and writes `<specFolder>/comparison.md`; returns the written path. */
export async function writeComparison(specFolder: string, dataPath: string): Promise<string> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(dataPath, 'utf8'))
  } catch (error) {
    throw new Error(`data: cannot read ${dataPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const page = renderComparison(validateComparisonData(raw))
  const target = join(resolve(specFolder), 'comparison.md')
  await writeFile(target, page)
  return target
}

if (import.meta.main) {
  const [specFolder, dataPath] = process.argv.slice(2)
  try {
    if (!specFolder || !dataPath) throw new Error('usage: comparison.ts <spec-folder> <comparison-data.json>')
    console.log(JSON.stringify({ written: await writeComparison(specFolder, dataPath) }))
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    process.exit(2)
  }
}

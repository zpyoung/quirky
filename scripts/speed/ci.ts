import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { parseArtifactJson } from '../test-baseline/baseline'
import { METRICS, type Comparison, type SpeedMiss, type SpeedPair, type SpeedReport } from './contracts'
import { comparePair, renderSpeed, validateMisses, validatePair, validateReport } from './report'

const MAX_JSON_BYTES = 5 * 1024 * 1024
const SHA = /^[0-9a-f]{40}$/
type Context = { cwd: string; err?: (text: string) => void }
type PairEvidence = { pair: SpeedPair | null; malformed: boolean; text: string | null }

function readJson(path: string): unknown {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error('evidence exceeds 5 MiB')
  return parseArtifactJson(readFileSync(path, 'utf8'))
}

function readPair(path: string): PairEvidence {
  if (!existsSync(path)) return { pair: null, malformed: false, text: null }
  let text = '{}'
  try {
    if (statSync(path).size > MAX_JSON_BYTES) throw new Error('evidence exceeds 5 MiB')
    text = readFileSync(path, 'utf8')
    const pair = validatePair(parseArtifactJson(text))
    return { pair, malformed: pair === null, text }
  } catch {
    return { pair: null, malformed: true, text }
  }
}

function readMisses(directory: string, current: SpeedReport): SpeedMiss[] | undefined {
  try {
    return validateMisses(readJson(join(directory, current.evidence.misses)), current) ?? undefined
  } catch {
    return undefined
  }
}

function state(status: 'unavailable' | 'error', current: SpeedReport | null, reason: string): Comparison {
  return {
    status, head: current ? { commit: current.commit, runId: current.runId, createdAt: current.createdAt } : null,
    baseline: null, reason, reasons: [reason], metrics: Object.fromEntries(METRICS.map(metric => [metric, null])) as Comparison['metrics'],
  }
}

function comparisonFromPair(current: SpeedReport, evidence: PairEvidence): Comparison {
  return evidence.malformed
    ? state('error', current, 'pair report is malformed')
    : comparePair(current, evidence.pair)
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(?:Bearer\s+|(?:token|authorization)[=: ]+)[^\s,;]+/gi, '[redacted]').replace(/[\r\n`|<>]/g, ' ').slice(0, 500)
}

/** Reads advisory evidence without allowing broken speed data to break the unit verdict. */
export function readSpeedEvidence(directory: string, head: string): string {
  let current: SpeedReport | null = null
  let misses: SpeedMiss[] | undefined
  try {
    current = validateReport(readJson(join(directory, 'report.json')))
    if (!current) throw new Error('invalid speed report')
    if (current.commit !== head) throw new Error('speed report HEAD does not match the unit plan')
    misses = readMisses(directory, current)
    if (current.status !== 'complete') return renderSpeed(current, undefined, misses)
    if (!current.qualified) throw new Error('smoke report is not a qualifying measurement')
    const recomputed = comparisonFromPair(current, readPair(join(directory, 'pair.json')))
    const stored = readJson(join(directory, 'comparison.json'))
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('invalid speed comparison')
    if (!isDeepStrictEqual(stored, recomputed)) throw new Error('comparison disagrees with paired samples')
    return renderSpeed(current, recomputed, misses)
  } catch (error) {
    return renderSpeed(null, state('error', current, `speed evidence: ${safeReason(error)}`), misses)
  }
}

/** Compares local paired samples; speed remains advisory. */
export async function runCi(argv: string[], ctx: Context = { cwd: process.cwd() }): Promise<number> {
  let values: { current: string; pair: string; out: string; head: string }
  try {
    if (argv[0] !== 'compare') throw new Error('expected compare')
    const parsed = parseArgs({
      args: argv.slice(1), strict: true, allowPositionals: false,
      options: { current: { type: 'string' }, pair: { type: 'string' }, out: { type: 'string' }, head: { type: 'string' } },
    }).values
    if (!parsed.current || !parsed.pair || !parsed.out || !parsed.head || !SHA.test(parsed.head)) {
      throw new Error('compare requires --current, --pair, --out and a 40-hex --head')
    }
    values = parsed as typeof values
  } catch (error) {
    ctx.err?.(`${safeReason(error)}\n`)
    return 2
  }

  const out = resolve(ctx.cwd, values.out)
  mkdirSync(out, { recursive: true })
  let current: SpeedReport | null = null
  let misses: SpeedMiss[] | undefined
  let comparison: Comparison
  let code = 0
  try {
    const currentPath = resolve(ctx.cwd, values.current)
    current = validateReport(readJson(currentPath))
    if (!current) throw new Error('current report is malformed')
    if (current.commit !== values.head) throw new Error('current report HEAD mismatch')
    if (current.status !== 'complete' || !current.qualified || current.cleanup !== 'complete') throw new Error('current report is incomplete or unqualified')
    misses = readMisses(dirname(currentPath), current)
    const outMissesPath = join(out, current.evidence.misses)
    if (misses === undefined) {
      rmSync(outMissesPath, { force: true, recursive: true })
    } else {
      mkdirSync(dirname(outMissesPath), { recursive: true })
      writeFileSync(outMissesPath, JSON.stringify(misses, null, 2) + '\n')
    }
    writeFileSync(join(out, 'report.json'), JSON.stringify(current, null, 2) + '\n')

    const pairEvidence = readPair(resolve(ctx.cwd, values.pair))
    const outPairPath = join(out, 'pair.json')
    if (pairEvidence.text === null) {
      rmSync(outPairPath, { force: true, recursive: true })
    } else {
      writeFileSync(outPairPath, pairEvidence.text)
    }
    comparison = comparisonFromPair(current, pairEvidence)
  } catch (error) {
    code = 2
    comparison = state('error', current, `speed comparison: ${safeReason(error)}`)
  }
  writeFileSync(join(out, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
  writeFileSync(join(out, 'summary.md'), renderSpeed(current, comparison, misses))
  return code
}

if (import.meta.main) process.exitCode = await runCi(process.argv.slice(2))

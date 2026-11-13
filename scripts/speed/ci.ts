import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultGh, fetchBaseline, findBaselines, parseArtifactJson, type BaselineArtifact } from '../test-baseline/baseline'
import type { GhRunner } from '../test-baseline/types'
import { METRICS, type Comparison, type SpeedMiss, type SpeedReport } from './contracts'
import { compareReports, compatibleProfiles, renderSpeed, validateMisses, validateReport } from './report'

const MAX_JSON_BYTES = 5 * 1024 * 1024
const SHA = /^[0-9a-f]{40}$/
type Provenance = { repository: string; commit: string; artifactId: number; event: 'push'; workflowPath: '.github/workflows/tests.yml' }
type EvidenceComparison = Comparison & { provenance?: Provenance }
type Context = { cwd: string; env: Record<string, string | undefined>; gh?: GhRunner; download?: (args: string[], dest: string) => Promise<void>; err?: (text: string) => void }

export const SPEED_ARTIFACT: BaselineArtifact<SpeedReport> = {
  name: /^speed-baseline-([0-9a-f]{40})$/, entry: 'report.json', cacheNamespace: 'speed-baseline', maxJsonBytes: MAX_JSON_BYTES,
  source: { event: 'push', workflowPath: '.github/workflows/tests.yml' },
  validate(value) {
    const report = validateReport(value)
    return report?.status === 'complete' && report.qualified && report.cleanup === 'complete' ? report : null
  },
}

function readJson(path: string): unknown {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error('evidence exceeds 5 MiB')
  return parseArtifactJson(readFileSync(path, 'utf8'))
}

function readMisses(directory: string, current: SpeedReport): SpeedMiss[] | undefined {
  try {
    return validateMisses(readJson(join(directory, current.evidence.misses)), current) ?? undefined
  } catch {
    return undefined
  }
}

function state(status: 'unavailable' | 'error', current: SpeedReport | null, reason: string): EvidenceComparison {
  return {
    status, head: current ? { commit: current.commit, runId: current.runId, createdAt: current.createdAt } : null,
    baseline: null, reason, reasons: [reason], metrics: Object.fromEntries(METRICS.map(metric => [metric, null])) as Comparison['metrics'],
  }
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
    const value = readJson(join(directory, 'comparison.json'))
    if (!value || typeof value !== 'object') throw new Error('invalid speed comparison')
    const comparison = value as EvidenceComparison
    if (comparison.head?.commit !== head) throw new Error('comparison HEAD mismatch')
    if (comparison.status === 'error') {
      if (typeof comparison.reason !== 'string' || !comparison.reason) throw new Error('invalid comparison error')
      return renderSpeed(current, state('error', current, safeReason(comparison.reason)), misses)
    }
    if (comparison.status === 'unavailable') {
      if (typeof comparison.reason !== 'string' || !comparison.reason || comparison.baseline !== null) throw new Error('invalid unavailable comparison')
      return renderSpeed(current, state('unavailable', current, safeReason(comparison.reason)), misses)
    }
    if (comparison.status !== 'compared') throw new Error('invalid comparison status')
    const baseline = SPEED_ARTIFACT.validate(readJson(join(directory, 'baseline.json')))
    const provenance = comparison.provenance
    if (!baseline || !provenance || provenance.commit !== baseline.commit || provenance.event !== 'push' || provenance.workflowPath !== '.github/workflows/tests.yml' || !Number.isSafeInteger(provenance.artifactId) || provenance.artifactId <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(provenance.repository)) throw new Error('invalid baseline provenance')
    const recomputed = compareReports(current, baseline)
    if (recomputed.status !== 'compared' || comparison.baseline?.commit !== baseline.commit || JSON.stringify(comparison.metrics) !== JSON.stringify(recomputed.metrics)) throw new Error('comparison disagrees with validated samples or profile')
    return renderSpeed(current, recomputed, misses)
  } catch (error) {
    return renderSpeed(null, state('error', current, `speed evidence: ${safeReason(error)}`), misses)
  }
}

/** Compares only trusted compatible first-parent main artifacts; speed remains advisory. */
export async function runCi(argv: string[], ctx: Context = { cwd: process.cwd(), env: process.env }): Promise<number> {
  let values: { current: string; out: string; event: string; head: string }
  try {
    if (argv[0] !== 'compare') throw new Error('expected compare')
    const parsed = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false, options: { current: { type: 'string' }, out: { type: 'string' }, event: { type: 'string' }, head: { type: 'string' } } }).values
    if (!parsed.current || !parsed.out || !parsed.event || !parsed.head || !['pull_request', 'push', 'workflow_dispatch'].includes(parsed.event) || !SHA.test(parsed.head)) throw new Error('compare requires --current, --out, --event and a 40-hex --head')
    values = parsed as typeof values
  } catch (error) {
    ctx.err?.(`${safeReason(error)}\n`)
    return 2
  }
  const out = resolve(ctx.cwd, values.out)
  mkdirSync(out, { recursive: true })
  let current: SpeedReport | null = null
  let misses: SpeedMiss[] | undefined
  let comparison: EvidenceComparison
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
    const repo = ctx.env.GITHUB_REPOSITORY
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is missing or invalid')
    const candidates = await findBaselines({ cwd: ctx.cwd, head: values.head, repo, gh: ctx.gh ?? defaultGh, fromParent: values.event !== 'pull_request', artifact: SPEED_ARTIFACT }, 500)
    comparison = state('unavailable', current, 'no qualifying compatible main baseline in the first 500 ancestors')
    rmSync(join(out, 'baseline.json'), { force: true })
    for (const found of candidates) {
      const baseline = await fetchBaseline(found, { cwd: ctx.cwd, repo, gh: ctx.gh ?? defaultGh, download: ctx.download, artifact: SPEED_ARTIFACT })
      if (!compatibleProfiles(current.profile, baseline.profile)) continue
      comparison = { ...compareReports(current, baseline), provenance: { repository: repo, commit: found.commit, artifactId: found.artifactId, event: 'push', workflowPath: '.github/workflows/tests.yml' } }
      writeFileSync(join(out, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n')
      break
    }
  } catch (error) {
    code = 2
    comparison = state('error', current, `speed comparison: ${safeReason(error)}`)
  }
  writeFileSync(join(out, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
  writeFileSync(join(out, 'summary.md'), renderSpeed(current, comparison, misses))
  return code
}


if (import.meta.main) process.exitCode = await runCi(process.argv.slice(2))

#!/usr/bin/env bun
/**
 * Scores a feature's surfaces with ui:review and applies the redesign score gate.
 *
 *   bun scripts/redesign/score.ts run --plugin <id>... --out <dir> [--author-family anthropic]
 *   bun scripts/redesign/score.ts gate --before <scores.json> --after <scores.json> [--removed <surface-id>]...
 *
 * Prints one JSON object on stdout; diagnostics go to stderr. Exit 0 on success, 1 when the gate
 * fails, 2 on bad arguments or a broken environment.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { GateReport, GateRow, Scores, SurfaceScore, Theme } from './contracts'

export const SCORE_FLOOR = 85

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const THEMES: readonly Theme[] = ['dark', 'light']
const STDERR_TAIL_LINES = 10

/** Runs `scripts/ui-review.ts` with the given arguments; injectable so tests never launch a browser. */
export type UiReviewRunner = (input: { args: string[]; outputDir: string }) => Promise<{ exitCode: number; stderrTail: string }>

export type RunScoreOptions = { plugins: string[]; out: string; authorFamily: string }

export type CliResult = { exitCode: number; json: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pluginOfTarget(targetId: string): string {
  const afterKind = targetId.includes(':') ? targetId.slice(targetId.indexOf(':') + 1) : targetId
  return afterKind.split('/')[0] ?? afterKind
}

/**
 * Collapses a ui:review `review-report.json` into one row per target with a dark and a light score.
 * A theme whose capture is missing, or whose target was not visibly present, scores `null`.
 * Throws when the report has no `captures` array.
 */
export function scoresFromReport(report: unknown, plugins: string[], reportPath = ''): Scores {
  if (!isRecord(report) || !Array.isArray(report.captures)) {
    throw new Error('review report has no captures array')
  }
  const byTarget = new Map<string, SurfaceScore>()
  for (const entry of report.captures) {
    if (!isRecord(entry) || typeof entry.targetId !== 'string') continue
    if (entry.theme !== 'dark' && entry.theme !== 'light') continue
    const surface =
      byTarget.get(entry.targetId) ??
      { id: entry.targetId, plugin: pluginOfTarget(entry.targetId), dark: null, light: null }
    const visible = isRecord(entry.assessment) && entry.assessment.targetVisible === true
    surface[entry.theme] = visible && typeof entry.score === 'number' ? entry.score : null
    byTarget.set(entry.targetId, surface)
  }
  return {
    createdAt: typeof report.createdAt === 'string' ? report.createdAt : new Date().toISOString(),
    plugins,
    reportPath,
    surfaces: [...byTarget.values()]
  }
}

function pair(surface: SurfaceScore): { dark: number | null; light: number | null } {
  return { dark: surface.dark, light: surface.light }
}

function judgeAfter(
  before: SurfaceScore | undefined,
  after: SurfaceScore
): string[] {
  const reasons: string[] = []
  for (const theme of THEMES) {
    const now = after[theme]
    if (now === null) {
      reasons.push(`${theme} not captured`)
      continue
    }
    if (now < SCORE_FLOOR) reasons.push(`${theme} ${now} below ${SCORE_FLOOR}`)
    const was = before?.[theme] ?? null
    if (was !== null && now < was) reasons.push(`${theme} ${now} below before ${was}`)
  }
  return reasons
}

/**
 * Applies the score gate to a before and an after `Scores`. A surface clears when both after themes
 * reach `SCORE_FLOOR` and neither drops below its before score. `removed` names surfaces that were
 * deliberately cut, so they are not held to "missing after". `passed` is true when no row fails.
 */
export function applyGate(before: Scores, after: Scores, removed: string[]): GateReport {
  const beforeById = new Map(before.surfaces.map((surface) => [surface.id, surface]))
  const afterById = new Map(after.surfaces.map((surface) => [surface.id, surface]))
  const rows: GateRow[] = []

  for (const was of before.surfaces) {
    const now = afterById.get(was.id)
    if (now) {
      const reasons = judgeAfter(was, now)
      rows.push({ id: was.id, before: pair(was), after: pair(now), result: reasons.length === 0 ? 'clears' : 'fails', reasons })
    } else if (removed.includes(was.id)) {
      rows.push({ id: was.id, before: pair(was), after: null, result: 'removed', reasons: [] })
    } else {
      rows.push({ id: was.id, before: pair(was), after: null, result: 'fails', reasons: ['missing after'] })
    }
  }
  for (const now of after.surfaces) {
    if (beforeById.has(now.id)) continue
    const reasons = judgeAfter(undefined, now)
    rows.push({ id: now.id, before: null, after: pair(now), result: reasons.length === 0 ? 'new' : 'fails', reasons })
  }
  return { passed: rows.every((row) => row.result !== 'fails'), floor: SCORE_FLOOR, rows }
}

const spawnUiReview: UiReviewRunner = async ({ args }) => {
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, 'scripts', 'ui-review.ts'), ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  // ui:review's stdout is progress here; ours is reserved for the one JSON object
  const forward = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      process.stderr.write(chunk.value)
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text
  }
  const [, stderr, exitCode] = await Promise.all([forward(proc.stdout), forward(proc.stderr), proc.exited])
  const tail = stderr.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n')
  return { exitCode, stderrTail: tail }
}

/**
 * Runs ui:review for the given plugins into a fresh `<out>/ui-review` and writes `<out>/scores.json`.
 * ui:review's own exit 1 (below threshold) is not a failure: the result is exit 0 whenever the
 * report exists with status `passed` or `failed`, and exit 2 otherwise.
 */
export async function runScore(options: RunScoreOptions, runner: UiReviewRunner = spawnUiReview): Promise<CliResult> {
  const out = resolve(options.out)
  if (existsSync(out)) return { exitCode: 2, json: { error: `output directory already exists: ${out}` } }
  await mkdir(out, { recursive: true })
  const outputDir = join(out, 'ui-review')
  const args = [
    '--author-family',
    options.authorFamily,
    '--output',
    outputDir,
    '--threshold',
    String(SCORE_FLOOR),
    ...options.plugins.flatMap((plugin) => ['--only', plugin])
  ]
  const { exitCode, stderrTail } = await runner({ args, outputDir })

  const reportPath = join(outputDir, 'review-report.json')
  const fail = (reason: string) => ({
    exitCode: 2,
    json: { error: stderrTail ? `${reason}: ${stderrTail}` : reason }
  })
  if (!existsSync(reportPath)) return fail(`ui:review exited ${exitCode} without a review-report.json`)

  let report: unknown
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch {
    return fail('review-report.json is not valid JSON')
  }
  const status = isRecord(report) ? report.status : undefined
  if (status !== 'passed' && status !== 'failed') return fail(`ui:review report status is ${String(status)}`)

  let scores: Scores
  try {
    scores = scoresFromReport(report, options.plugins, reportPath)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  const scoresPath = join(out, 'scores.json')
  await writeFile(scoresPath, `${JSON.stringify(scores, null, 2)}\n`)
  return { exitCode: 0, json: { scores: scoresPath, status, surfaces: scores.surfaces.length } }
}

async function readScores(path: string, flag: string): Promise<Scores> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${flag} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.surfaces)) throw new Error(`${flag} ${path} is not a Scores file`)
  for (const surface of parsed.surfaces) {
    if (!isRecord(surface) || typeof surface.id !== 'string') throw new Error(`${flag} ${path} has a surface without an id`)
    if (typeof surface.plugin !== 'string') throw new Error(`${flag} ${path} surface ${surface.id} has no plugin`)
    for (const theme of THEMES) {
      const value = surface[theme]
      if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`${flag} ${path} surface ${surface.id} needs ${theme} as a finite number or null`)
      }
    }
  }
  return parsed as Scores
}

type ParsedFlags = Record<string, string[]>

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {}
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    const value = args[index + 1]
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`)
    }
    ;(flags[flag] ??= []).push(value)
    index++
  }
  return flags
}

function single(flags: ParsedFlags, name: string): string | undefined {
  const values = flags[name]
  if (values && values.length > 1) throw new Error(`${name} given more than once`)
  return values?.[0]
}

/** Parses argv (without the interpreter and script) and runs one subcommand. */
export async function main(argv: string[]): Promise<CliResult> {
  const [command, ...rest] = argv
  try {
    const flags = parseFlags(rest)
    if (command === 'run') {
      const plugins = flags['--plugin'] ?? []
      const out = single(flags, '--out')
      if (plugins.length === 0) throw new Error('run needs at least one --plugin')
      if (!out) throw new Error('run needs --out')
      return await runScore({ plugins, out: isAbsolute(out) ? out : resolve(out), authorFamily: single(flags, '--author-family') ?? 'anthropic' })
    }
    if (command === 'gate') {
      const beforePath = single(flags, '--before')
      const afterPath = single(flags, '--after')
      if (!beforePath) throw new Error('gate needs --before')
      if (!afterPath) throw new Error('gate needs --after')
      const gate = applyGate(await readScores(beforePath, '--before'), await readScores(afterPath, '--after'), flags['--removed'] ?? [])
      return { exitCode: gate.passed ? 0 : 1, json: gate }
    }
    throw new Error(`unknown command ${command ?? '(none)'}; use run or gate`)
  } catch (error) {
    return { exitCode: 2, json: { error: error instanceof Error ? error.message : String(error) } }
  }
}

if (import.meta.main) {
  const { exitCode, json } = await main(process.argv.slice(2))
  console.log(JSON.stringify(json))
  process.exit(exitCode)
}

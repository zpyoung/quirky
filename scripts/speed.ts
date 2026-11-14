import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, arch, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { chromiumPath, openWindows, type SoakWindows } from './soak/windows.ts'
import { startWorld, type SoakWorld } from './soak/world.ts'
import { prepareSpeedFixture, type SpeedFixture } from './speed/fixtures.ts'
import { measureSpeed, sanitizeSpeedArtifacts, type SpeedMeasurementResult } from './speed/measure.ts'
import { BUDGETS, METRICS, PAIR_COUNTS, type PairBasis, type SpeedPair, type SpeedReport } from './speed/contracts.ts'
import { createMisses, median, renderSpeed, validatePair, validateReport } from './speed/report.ts'

const HELP = 'usage: bun scripts/speed.ts --out <directory> [--samples <integer >= 20> | --smoke] [--base-root <directory> --base-basis merge-base|parent] [--seed-echo-delay-ms <1..2000>]\n       bun scripts/speed.ts --help\n'
const SETUP_MS = 5 * 60_000
const RUN_MS = 20 * 60_000
const PAIRED_RUN_MS = 50 * 60_000

function scrubArtifacts(out: string, redactions: string[]): void {
  sanitizeSpeedArtifacts(out, redactions)
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!entry.isFile() || !/\.(json|jsonl|md|log|txt|trace)$/i.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
        .replace(/(?:\/private)?\/var\/folders\/[^/\s"'<>]+\/[^/\s"'<>]+\/T\/(?:quirky|speed|owned)[^/\s"'<>]*/g, '<speed-home>')
        .replace(/(?:\/private)?\/tmp\/(?:quirky|speed|owned)[^/\s"'<>]*/g, '<speed-home>')
        .replace(/(["']?(?:hookToken|bearerToken|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1<redacted>')
      writeFileSync(path, text)
    }
  }
  visit(out)
}

/** Measures only disposable local state, and publishes evidence only after owned cleanup settles. */
export async function main(args: string[], measure: typeof measureSpeed = measureSpeed): Promise<number> {
  let out: string
  let count: number
  let smoke: boolean
  let executable: string
  let baseRoot: string | undefined
  let baseBasis: PairBasis | undefined
  let echoDelayMs: number | undefined
  try {
    const values = parseArgs({ args, strict: true, allowPositionals: false, options: {
      out: { type: 'string' }, samples: { type: 'string' }, smoke: { type: 'boolean' }, help: { type: 'boolean' },
      'base-root': { type: 'string' }, 'base-basis': { type: 'string' }, 'seed-echo-delay-ms': { type: 'string' },
    } }).values
    if (values.help) { process.stdout.write(HELP); return 0 }
    if (!values.out?.trim()) throw new Error('--out is required')
    smoke = values.smoke === true
    if (smoke && values.samples !== undefined) throw new Error('--smoke and --samples are mutually exclusive')
    if (values.samples !== undefined && !/^[0-9]+$/.test(values.samples)) throw new Error('--samples must be an integer >= 20')
    count = smoke ? 1 : Number(values.samples ?? '20')
    if (!Number.isSafeInteger(count) || (!smoke && count < 20)) throw new Error('--samples must be an integer >= 20')
    if ((values['base-root'] !== undefined || values['base-basis'] !== undefined)
      && (!values['base-root']?.trim() || !['merge-base', 'parent'].includes(values['base-basis'] ?? ''))) {
      throw new Error('--base-root and --base-basis go together; basis is merge-base or parent')
    }
    baseRoot = values['base-root'] ? resolve(values['base-root']) : undefined
    baseBasis = values['base-basis'] as PairBasis | undefined
    if (values['seed-echo-delay-ms'] !== undefined) {
      if (!smoke || !baseRoot) throw new Error('--seed-echo-delay-ms requires --smoke and --base-root')
      echoDelayMs = Number(values['seed-echo-delay-ms'])
      if (!/^\d+$/.test(values['seed-echo-delay-ms']) || !Number.isSafeInteger(echoDelayMs) || echoDelayMs < 1 || echoDelayMs > 2000) {
        throw new Error('--seed-echo-delay-ms must be an integer from 1 to 2000')
      }
    }
    const found = chromiumPath()
    if (found === null) throw new Error('Chromium is unavailable; no daemon was started')
    executable = found
    out = resolve(values.out)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`)
    return 2
  }

  const repoRoot = resolve(import.meta.dir, '..')
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot })
  const commit = git.stdout.toString().trim()
  if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit)) { process.stderr.write('cannot resolve benchmark commit\n'); return 2 }
  let baseCommit: string | undefined
  if (baseRoot) {
    const baseGit = Bun.spawnSync(['git', '-C', baseRoot, 'rev-parse', 'HEAD'])
    baseCommit = baseGit.stdout.toString().trim()
    if (baseGit.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(baseCommit)) { process.stderr.write('cannot resolve base benchmark commit\n'); return 2 }
  }
  const cpu = cpus()
  if (cpu.length === 0 || !cpu[0]?.model) { process.stderr.write('CPU profile is unavailable\n'); return 2 }
  mkdirSync(out, { recursive: true })
  const controller = new AbortController()
  let signalExit: number | undefined
  const interrupt = () => { signalExit = 130; controller.abort(new Error('SIGINT')) }
  const terminate = () => { signalExit = 143; controller.abort(new Error('SIGTERM')) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let timer = setTimeout(() => controller.abort(new Error('setup exceeded five-minute deadline')), SETUP_MS)
  let world: SoakWorld | undefined
  let fixture: SpeedFixture | undefined
  let windows: SoakWindows | undefined
  let baseWorld: SoakWorld | undefined
  let baseFixture: SpeedFixture | undefined
  let baseWindows: SoakWindows | undefined
  let result: SpeedMeasurementResult | undefined
  const redactions: string[] = []
  const failures: SpeedReport['failures'] = []
  let cleanup: SpeedReport['cleanup'] = 'complete'
  let chromiumVersion = 'unavailable'
  const profile: SpeedReport['profile'] = {
    workloadVersion: 2, compositor: 'software', worktrees: 10, terminals: 20, diffAddedLines: 5000,
    renderer: 'dom', viewport: { width: 1400, height: 880 }, startup: 'daemon-restart-persistent-pty-fresh-context',
    floodChunkBytes: 65536, floodIntervalMs: 16,
    runner: process.env.QUIRKY_SPEED_RUNNER || 'local', os: platform(), arch: arch(), cpuModel: cpu[0]!.model, cpuCount: cpu.length,
    bun: Bun.version, chromium: chromiumVersion, imageVersion: process.env.QUIRKY_SPEED_IMAGE_VERSION || process.env.ImageVersion || 'local',
  }

  const retireSoloResources = async () => {
    const errors: string[] = []
    const resources: { name: string; stop(): Promise<void>; clear(): void }[] = [
      { name: 'solo-fixture', stop: async () => { await fixture?.stop() }, clear: () => { fixture = undefined } },
      { name: 'solo-browser', stop: async () => { await windows?.stop() }, clear: () => { windows = undefined } },
      { name: 'solo-process-scope', stop: async () => { await world?.stop() }, clear: () => { world = undefined } }
    ]
    for (const resource of resources) {
      try {
        await resource.stop()
        resource.clear()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        cleanup = 'failed'
        failures.push({ kind: 'cleanup-failed', message: `${resource.name}: ${message}` })
        errors.push(`${resource.name}: ${message}`)
      }
    }
    if (errors.length > 0) throw new Error(`could not retire solo measurement subject: ${errors.join('; ')}`)
  }
  try {
    world = await startWorld({ out, repoRoot, windows: 1, workers: false, signal: controller.signal })
    redactions.push(world.home, ...Object.entries(world.runtime).flatMap(([key, value]) => /token/i.test(key) && typeof value === 'string' ? [value] : []))
    fixture = await prepareSpeedFixture(world, { signal: controller.signal, echoDelayMs })
    windows = await openWindows({ world, count: 1, executable, out, signal: controller.signal, browserArgs: ['--disable-gpu'] })
    const browser = windows.pages[0]?.context().browser()
    if (!browser) throw new Error('Chromium browser is unavailable after setup')
    chromiumVersion = browser.version()
    profile.chromium = chromiumVersion
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error(baseRoot ? 'run exceeded fifty-minute deadline' : 'run exceeded twenty-minute deadline')), baseRoot ? PAIRED_RUN_MS : RUN_MS)
    result = await measure({
      world, fixture, windows, samples: count, out, signal: controller.signal,
      pair: baseRoot ? {
        async start(signal) {
          const setup = new AbortController()
          const setupTimer = setTimeout(() => setup.abort(new Error('paired setup exceeded five-minute deadline')), SETUP_MS)
          const setupSignal = AbortSignal.any([signal, setup.signal])
          try {
            await retireSoloResources()

            const pairHeadOut = join(out, 'pair-head')
            const pairedHeadWorld = await startWorld({ out: pairHeadOut, repoRoot, windows: 1, workers: false, signal: setupSignal })
            world = pairedHeadWorld
            redactions.push(pairedHeadWorld.home, ...Object.entries(pairedHeadWorld.runtime).flatMap(([key, value]) => /token/i.test(key) && typeof value === 'string' ? [value] : []))
            const pairedHeadFixture = await prepareSpeedFixture(pairedHeadWorld, { signal: setupSignal, echoDelayMs })
            fixture = pairedHeadFixture
            const pairedHeadWindows = await openWindows({ world: pairedHeadWorld, count: 1, executable, out: pairHeadOut, signal: setupSignal, browserArgs: ['--disable-gpu'] })
            windows = pairedHeadWindows

            const baseOut = join(out, 'base')
            baseWorld = await startWorld({ out: baseOut, repoRoot: baseRoot!, windows: 1, workers: false, signal: setupSignal })
            redactions.push(baseWorld.home, ...Object.entries(baseWorld.runtime).flatMap(([key, value]) => /token/i.test(key) && typeof value === 'string' ? [value] : []))
            baseFixture = await prepareSpeedFixture(baseWorld, { signal: setupSignal })
            baseWindows = await openWindows({ world: baseWorld, count: 1, executable, out: baseOut, signal: setupSignal, browserArgs: ['--disable-gpu'] })
            return {
              head: { world: pairedHeadWorld, fixture: pairedHeadFixture, windows: pairedHeadWindows },
              base: { world: baseWorld, fixture: baseFixture, windows: baseWindows }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('; cleanup failed:')) {
              cleanup = 'failed'
              failures.push({ kind: 'cleanup-failed', message: `paired-setup: ${message}` })
            }
            throw error
          } finally {
            clearTimeout(setupTimer)
          }
        },
      } : undefined,
    })
    failures.push(...result.failures)
    for (const error of result.diagnosticErrors) failures.push({ kind: 'diagnostic-evidence-error', message: error })
    redactions.push(...result.redactions)
    if (METRICS.some(metric => result!.samples[metric].length !== count)) failures.push({ kind: 'short-run', message: 'not every metric produced the requested successful samples' })
  } catch (error) {
    failures.push({ kind: controller.signal.aborted ? 'interrupted' : 'setup-or-run-failed', message: error instanceof Error ? error.message : String(error) })
  } finally {
    clearTimeout(timer)
    for (const [name, stop] of [
      ['base-fixture', async () => { await baseFixture?.stop() }],
      ['base-browser', async () => { await baseWindows?.stop() }],
      ['base-process-scope', async () => { await baseWorld?.stop() }],
      ['fixture', async () => { await fixture?.stop() }],
      ['browser', async () => { await windows?.stop() }],
      ['process-scope', async () => { await world?.stop() }],
    ] as const) {
      try { await stop() } catch (error) {
        cleanup = 'failed'
        failures.push({ kind: 'cleanup-failed', message: `${name}: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
  if (world) redactions.push(world.home, ...Object.entries(world.runtime).flatMap(([key, value]) => /token/i.test(key) && typeof value === 'string' ? [value] : []))
  else {
    rmSync(join(out, 'daemon.log'), { force: true })
    rmSync(join(out, 'ui-build.log'), { force: true })
  }
  if (baseWorld) redactions.push(baseWorld.home, ...Object.entries(baseWorld.runtime).flatMap(([key, value]) => /token/i.test(key) && typeof value === 'string' ? [value] : []))
  for (const failure of [...failures, ...(result?.pair?.failures ?? [])]) {
    for (const secret of redactions) if (secret) failure.message = failure.message.replaceAll(secret, '<redacted>')
    failure.message = failure.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2048)
  }

  const metrics = Object.fromEntries(METRICS.map(metric => {
    const samplesMs = result?.samples[metric] ?? []
    const medianMs = median(samplesMs)
    return [metric, { samplesMs, medianMs, budgetMs: BUDGETS[metric], budgetMiss: medianMs === null ? null : medianMs > BUDGETS[metric] }]
  })) as SpeedReport['metrics']
  const report: SpeedReport = {
    version: 1, commit, runId: process.env.GITHUB_RUN_ID || `local-${randomUUID()}`, createdAt: new Date().toISOString(),
    status: failures.length === 0 ? 'complete' : 'incomplete', qualified: !smoke && failures.length === 0,
    profile, metrics, failures, cleanup,
    evidence: { samples: 'samples.jsonl', diagnostics: result?.diagnostics ?? [], misses: 'misses.json' },
  }
  const misses = createMisses(report)
  for (const miss of misses) {
    try {
      const diagnostic: unknown = JSON.parse(readFileSync(join(out, `diagnostics/${miss.metric}.json`), 'utf8'))
      if (!diagnostic || typeof diagnostic !== 'object' || !('metric' in diagnostic) || diagnostic.metric !== miss.metric
        || !('status' in diagnostic) || diagnostic.status !== 'complete' || !('finding' in diagnostic) || typeof diagnostic.finding !== 'string') throw new Error('diagnostic finding unavailable')
      miss.finding = diagnostic.finding.slice(0, 2048)
    } catch {
      miss.finding = 'Diagnosis unavailable: diagnostic evidence error.'
      report.failures.push({ kind: 'diagnostic-evidence-error', metric: miss.metric, message: 'metric-specific diagnostic finding unavailable' })
      report.status = 'incomplete'
      report.qualified = false
    }
  }
  writeFileSync(join(out, 'samples.jsonl'), (result?.attempts ?? []).map(row => JSON.stringify(row)).join('\n') + '\n')
  if (baseRoot && baseCommit && baseBasis) {
    const paired = result?.pair
    const metrics = Object.fromEntries(METRICS.map(metric => [metric, {
      headSamplesMs: paired?.samples.head[metric] ?? [], baseSamplesMs: paired?.samples.base[metric] ?? [],
    }])) as SpeedPair['metrics']
    const pairFailures = paired?.failures ?? [{ kind: 'pair-interrupted', message: 'solo run did not reach the paired phase' }]
    const complete = pairFailures.length === 0 && METRICS.every(metric => {
      const row = metrics[metric]
      return row.headSamplesMs.length === row.baseSamplesMs.length && row.headSamplesMs.length >= (smoke ? 1 : PAIR_COUNTS[metric])
    })
    if (!complete && pairFailures.length === 0) pairFailures.push({ kind: 'pair-measurement-failed', message: 'not every metric produced the requested paired samples' })
    const pair: SpeedPair = {
      version: 1, runId: report.runId, createdAt: report.createdAt, status: complete ? 'complete' : 'incomplete',
      qualified: complete && !smoke, head: { commit }, base: { commit: baseCommit, basis: baseBasis },
      metrics, failures: pairFailures, evidence: { samples: 'pair-samples.jsonl' },
    }
    writeFileSync(join(out, 'pair.json'), JSON.stringify(pair, null, 2) + '\n')
    writeFileSync(join(out, 'pair-samples.jsonl'), (paired?.attempts ?? []).map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(out, 'misses.json'), JSON.stringify(misses, null, 2) + '\n')
  writeFileSync(join(out, 'summary.md'), renderSpeed(report, undefined, misses))
  try {
    scrubArtifacts(out, redactions)
    if (!validateReport(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')))) throw new Error('written report failed schema validation')
    if (baseRoot && !validatePair(JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8')))) throw new Error('written pair failed schema validation')
  } catch {
    report.status = 'incomplete'
    report.qualified = false
    report.cleanup = 'failed'
    report.failures = [{ kind: 'evidence-cleanup-failed', message: 'evidence sanitization or report validation failed' }]
    for (const name of ['daemon.log', 'ui-build.log', 'base', 'pair-head', 'traces', 'diagnostics', 'samples.jsonl', 'pair.json', 'pair-samples.jsonl', 'misses.json']) rmSync(join(out, name), { force: true, recursive: true })
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(out, 'samples.jsonl'), '')
    writeFileSync(join(out, 'misses.json'), '[]\n')
    writeFileSync(join(out, 'summary.md'), '### Speed\n\nnot measured: evidence sanitization failed\n')
    process.stderr.write('evidence sanitization or report validation failed\n')
    return 2
  }
  process.stdout.write(readFileSync(join(out, 'summary.md'), 'utf8'))
  if (cleanup === 'failed') return 2
  if (signalExit !== undefined) return signalExit
  return report.status === 'complete' ? 0 : 2
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArguments, USAGE, UsageError } from './soak/arguments.ts'
import type { Sample, SoakReport, WorkerBeat } from './soak/contracts.ts'
import { ownedProcesses, readProcessTable } from './soak/processes.ts'
import { startProbe, type Probe } from './soak/probe.ts'
import { judge } from './soak/verdict.ts'
import { startWorld, type SoakWorld } from './soak/world.ts'

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const done = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', done)
    resolve()
  }
  const timer = setTimeout(done, Math.max(0, ms))
  signal.addEventListener('abort', done, { once: true })
  return promise
}

function heartbeat(worktree: string, path: string, now: number): WorkerBeat {
  try {
    const last = readFileSync(join(path, 'soak-heartbeat.log'), 'utf8').trim().split('\n').at(-1) ?? ''
    const match = /^cycle \d+ (.+)$/.exec(last)
    const time = match ? Date.parse(match[1]!) : NaN
    return { worktree, lastBeatAgeSeconds: Number.isFinite(time) ? Math.max(0, (now - time) / 1000) : null }
  } catch {
    return { worktree, lastBeatAgeSeconds: null }
  }
}

async function commit(repoRoot: string): Promise<string> {
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  const [text, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error('could not read the checkout commit')
  return text.trim()
}

/** Runs an isolated real-daemon soak and returns its verdict or harness exit code. */
export async function main(argv: string[]): Promise<number> {
  let config
  try {
    config = parseArguments(argv)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message.replaceAll('\n', ' ') : String(error)}\n${USAGE}`)
    return 2
  }
  if ('help' in config) {
    console.log(USAGE)
    return 0
  }

  const setupAbort = new AbortController()
  const runAbort = new AbortController()
  let interrupted = 0
  const interrupt = (code: number) => {
    if (interrupted) return
    interrupted = code
    setupAbort.abort()
    runAbort.abort()
  }
  const onInt = () => interrupt(130)
  const onTerm = () => interrupt(143)
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  let world: SoakWorld | undefined
  let probe: Probe | undefined
  try {
    mkdirSync(config.out, { recursive: true })
    const repoRoot = resolve(import.meta.dir, '..')
    const revision = await commit(repoRoot)
    if (interrupted) return interrupted
    world = await startWorld({ out: config.out, repoRoot, signal: setupAbort.signal })
    if (interrupted) return interrupted
    const startedAt = performance.now()
    const startedIso = new Date().toISOString()
    let samplingStopped = false
    let daemonMissing = false
    probe = await startProbe({
      home: world.home,
      startedAt,
      signal: setupAbort.signal,
      onDaemonLost: () => {
        samplingStopped = true
        runAbort.abort()
      },
      onPtyHostPid: (pid) => world!.updatePtyHostPid(pid)
    })
    const elapsed = () => (performance.now() - startedAt) / 1000
    const samples: Sample[] = []
    const seen = new Set<string>()
    let skippedSamples = 0
    let attemptedSamples = 0
    const deadline = startedAt + config.minutes * 60_000
    const samplesPath = join(config.out, 'samples.jsonl')
    writeFileSync(samplesPath, '')
    while (!interrupted && !samplingStopped && performance.now() < deadline) {
      const sampleStart = performance.now()
      const at = Number(elapsed().toFixed(3))
      const rows = await readProcessTable()
      attemptedSamples++
      if (interrupted || samplingStopped) break
      if (rows === null) {
        skippedSamples++
      } else {
        if (!rows.some(({ pid }) => pid === world!.daemonPid)) {
          daemonMissing = true
          break
        }
        const ptyPid = world.ptyHostPid()
        const roots = ptyPid === null ? [world.daemonPid] : [world.daemonPid, ptyPid]
        const sample: Sample = {
          at,
          owned: ownedProcesses(rows, roots, seen),
          daemonRssKb: rows.find(({ pid }) => pid === world!.daemonPid)?.rssKb ?? null
        }
        samples.push(sample)
        appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`)
      }
      await pause(Math.min(sampleStart + 1000, deadline) - performance.now(), runAbort.signal)
    }
    if (interrupted) return interrupted
    probe.stop()
    const durationSeconds = Number(elapsed().toFixed(3))
    if (attemptedSamples > 0 && skippedSamples / attemptedSamples > 0.1) {
      throw new Error(`ps failed for ${skippedSamples} of ${attemptedSamples} samples`)
    }
    const now = Date.now()
    const evidence = {
      durationSeconds,
      windows: 0,
      samples,
      events: probe.events,
      probes: probe.probes,
      workers: world.workers.map(({ worktree, path }) => heartbeat(worktree, path, now)),
      daemonExited: daemonMissing || probe.daemonExited()
    }
    const judged = judge(evidence, config)
    const rss = samples.flatMap(({ daemonRssKb }) => daemonRssKb === null ? [] : [daemonRssKb])
    const report: SoakReport = {
      version: 1,
      commit: revision,
      startedAt: startedIso,
      durationSeconds,
      config: { minutes: config.minutes, windows: 0, worktrees: world.fixtures.worktrees.length, workers: world.workers.length, limits: config.limits },
      ...judged,
      daemon: { pid: world.daemonPid, rssKbFirst: rss[0] ?? null, rssKbMax: rss.length ? Math.max(...rss) : null, rssKbLast: rss.at(-1) ?? null },
      skippedSamples,
      files: { samples: samplesPath, daemonLog: join(config.out, 'daemon.log') }
    }
    writeFileSync(join(config.out, 'soak-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(config.out)
    for (const [name, check] of Object.entries(report.checks)) console.log(`${name}: ${check.ok ? 'pass' : 'fail'} ${JSON.stringify(check)}`)
    return report.verdict === 'pass' ? 0 : 1
  } catch (error) {
    if (interrupted) return interrupted
    const message = error instanceof Error ? error.message : String(error)
    console.error(world ? message.replaceAll(world.home, '<soak-home>') : message)
    if (error instanceof UsageError) console.error(USAGE)
    return 2
  } finally {
    probe?.stop()
    try {
      await world?.stop()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(world ? message.replaceAll(world.home, '<soak-home>') : message)
      rmSync(join(config.out, 'soak-report.json'), { force: true })
      return interrupted || 2
    } finally {
      process.removeListener('SIGINT', onInt)
      process.removeListener('SIGTERM', onTerm)
    }
    if (interrupted) {
      rmSync(join(config.out, 'soak-report.json'), { force: true })
      return interrupted
    }
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

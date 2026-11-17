#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readRuntime } from '@quirky/protocol/node'
import { parseArguments, USAGE, UsageError } from './soak/arguments.ts'
import type { DayInputs, PanelRequestRecord, PanelRefreshRecord, Sample, SoakReport, WindowRecord, WorkerBeat } from './soak/contracts.ts'
import { applyPhase, daySchedule, startDay, type DayDriver } from './soak/day.ts'
import { startFault, setGitDelay, type RunningFault } from './soak/faults.ts'
import { ownedProcesses, readProcessTable } from './soak/processes.ts'
import { startProbe, type Probe } from './soak/probe.ts'
import { isPanelRefreshRequest, judge, panelOfRequest, windowAlive } from './soak/verdict.ts'
import { chromiumPath, openWindows, type SoakWindows } from './soak/windows.ts'
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

function countSkippedBeats(workers: readonly { path: string }[]): number {
  let total = 0
  for (const worker of workers) {
    let text: string
    try {
      text = readFileSync(join(worker.path, 'soak-skips.log'), 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^skipped (\d+) .+$/.exec(line)
      if (match) total += Number(match[1])
    }
  }
  return total
}

async function commit(repoRoot: string): Promise<string> {
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  const [text, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error('could not read the checkout commit')
  return text.trim()
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

async function readyFaultWindows(
  world: SoakWorld, windows: SoakWindows, signal: AbortSignal, kind: 'feedback' | 'flood',
): Promise<WindowRecord[]> {
  const panel = `panel:soak.faults/${kind}`
  await world.control.callAny('ui.tool.open', { id: panel }, { timeoutMs: 5_000 })
  const records = (await windows.finish()).records
  const deadline = performance.now() + 30_000
  const pending = new Map(records.map((record) => [record.index, record]))
  while (pending.size > 0 && performance.now() < deadline) {
    if (signal.aborted) throw new Error(`${kind} panel readiness was interrupted`)
    for (const [index, record] of pending) {
      const state = await world.control.callAny('ui.window.state', { connId: record.connId }, {
        timeoutMs: Math.max(1, Math.min(1_000, deadline - performance.now())),
      }).catch((error: unknown) => {
        if (error instanceof Error && /^RPC call timed out after \d+(?:\.\d+)? ms$/.test(error.message)) return undefined
        throw error
      }) as {
        slots?: { id: string; shown: boolean; report?: { ready?: boolean; worktree?: string; error?: string | null } }[]
      } | undefined
      const slot = state?.slots?.find(({ id }) => id === panel)
      if (slot?.report?.error) throw new Error(`${kind} panel readiness: ${slot.report.error}`)
      if (slot?.shown && slot.report?.ready === true && slot.report.worktree === record.worktree) pending.delete(index)
      if (signal.aborted) throw new Error(`${kind} panel readiness was interrupted`)
      if (performance.now() >= deadline) break
    }
    if (pending.size) await pause(Math.min(100, Math.max(0, deadline - performance.now())), signal)
  }
  if (pending.size) throw new Error(`${kind} panel readiness missing for ${[...pending.values()].map(({ worktree }) => worktree).join(', ')} within 30000ms`)
  return records
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
  const executable = config.windows > 0 ? chromiumPath() : null
  if (config.windows > 0 && executable === null) {
    console.error('Chromium is not installed. Run "bunx playwright install chromium", or pass --windows 0.')
    return 2
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
  let fault: RunningFault | undefined
  let windows: SoakWindows | undefined
  let dayDriver: DayDriver | undefined
  let day: DayInputs | undefined
  const windowRequestSeconds = Array.from({ length: config.windows }, () => Array<number>(Math.ceil(config.minutes * 60)).fill(0))
  const panelRequests: PanelRequestRecord[] = []
  const panelRefreshes: PanelRefreshRecord[] = []
  let measurementStart: number | null = null
  let measurementEnd: number | null = null
  let floodWindow: { index: number; worktree: string } | undefined
  const floodSequences = new Set<number>()
  let floodObserved = 0
  let floodObservationError: string | null = null
  try {
    mkdirSync(config.out, { recursive: true })
    const repoRoot = resolve(import.meta.dir, '..')
    const revision = await commit(repoRoot)
    if (interrupted) return interrupted
    world = await startWorld({
      out: config.out,
      repoRoot,
      signal: setupAbort.signal,
      fault: config.fault,
      windows: config.windows,
      slowGit: config.slowGitMs !== undefined || config.fault === 'slow-git',
    })
    if (config.windows > 0) {
      windows = await openWindows({
        world, count: config.windows, executable: executable!, out: config.out, signal: setupAbort.signal,
        onRequest: (request) => {
          if (config.fault === 'flood' && request.method === 'soak.faults/floodTick') {
            floodObserved += 1
            const params = request.params as { owner?: unknown; sequence?: unknown } | null
            const sequence = params?.sequence
            let error: string | null = null
            if (measurementStart === null || measurementEnd === null || !Number.isFinite(request.at)
              || request.at < measurementStart || request.at >= measurementEnd) {
              error = 'a tick outside the measurement interval'
            } else if (!floodWindow || request.index !== floodWindow.index || request.worktree !== floodWindow.worktree
              || params?.owner !== floodWindow.worktree) {
              error = 'a tick from the wrong window or owner'
            } else if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 3000) {
              error = 'an invalid tick sequence'
            } else if (floodSequences.has(sequence)) {
              error = 'a duplicate tick sequence'
            } else {
              floodSequences.add(sequence)
            }
            floodObservationError ??= error
          }
          if (measurementStart === null || measurementEnd === null || request.at < measurementStart || request.at >= measurementEnd) return
          const at = Number(((request.at - measurementStart) / 1000).toFixed(3))
          const buckets = windowRequestSeconds[request.index]!
          const second = Math.floor((request.at - measurementStart) / 1000)
          buckets[second] = (buckets[second] ?? 0) + 1
          const panel = panelOfRequest(request.method, request.params)
          if (panel !== null) panelRequests.push({ at, index: request.index, panel })
          if (isPanelRefreshRequest(request.method, request.params)) panelRefreshes.push({
            at, index: request.index, worktree: request.worktree, method: request.method
          })
        }
      })
      await applyPhase({ control: world.control, windows, phase: 0, previous: null, signal: setupAbort.signal })
      day = {
        enabled: config.fault === undefined,
        windows: windows.liveness!().map(({ index, worktree }) => ({ index, worktree })),
        worktrees: world.fixtures.worktrees.map(({ id }) => id)
      }
    }
    let feedbackWorktrees: [string, string] | undefined
    if (config.fault === 'feedback' || config.fault === 'flood') {
      const ready = await readyFaultWindows(world, windows!, setupAbort.signal, config.fault)
      if (config.fault === 'feedback') {
        const pair = ready.slice(0, 2).map(({ worktree }) => worktree)
        if (pair.length !== 2 || !pair[0] || !pair[1] || pair[0] === pair[1]) {
          throw new Error('feedback needs two distinct ready window worktrees')
        }
        feedbackWorktrees = [pair[0], pair[1]]
      } else {
        const target = ready.find(({ index }) => index === 0)
        if (!target || !target.worktree.trim() || ready.length !== config.windows
          || new Set(ready.map(({ worktree }) => worktree)).size !== ready.length) {
          throw new Error('flood needs distinct ready window worktrees including index 0')
        }
        floodWindow = { index: target.index, worktree: target.worktree }
      }
    }
    if (interrupted) return interrupted
    if (config.slowGitMs !== undefined) setGitDelay(world.home, config.slowGitMs)
    const startedAt = performance.now()
    measurementStart = startedAt
    measurementEnd = startedAt + config.minutes * 60_000
    const startedIso = new Date().toISOString()
    if (day?.enabled) {
      dayDriver = startDay({
        control: world.control, windows: windows!, startedAt, signal: runAbort.signal,
        schedule: daySchedule({ seconds: config.minutes * 60, windows: day.windows, worktrees: day.worktrees })
      })
    }
    let samplingStopped = false
    let daemonMissing = false
    probe = startProbe({
      home: world.home,
      startedAt,
      signal: runAbort.signal,
      maxStallMs: config.limits.maxStallMs,
      gitProbe: { worktrees: world.fixtures.worktrees.map(({ id }) => id) },
      ...(world.workers[0] ? { terminalProbe: { session: world.workers[0].session } } : {}),
      isDaemonDead: () => daemonMissing || world!.control.isClosed || readRuntime(world!.home) === null || !isPidAlive(world!.daemonPid),
      onDaemonLost: () => {
        samplingStopped = true
        runAbort.abort()
      },
      onPtyHostPid: (pid) => world!.updatePtyHostPid(pid)
    })
    if (config.fault) {
      fault = startFault({
        kind: config.fault,
        home: world.home,
        repoRoot,
        ptyHostPid: () => world!.ptyHostPid(),
        control: world.control,
        projects: world.fixtures.worktrees.filter(({ isMain }) => isMain).map(({ path }) => path),
        out: config.out,
        runSeconds: config.minutes * 60,
        startedAt,
        signal: runAbort.signal,
        feedbackWorktrees,
        floodWindow,
      })
    }
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
    measurementEnd = Math.min(performance.now(), measurementEnd!)
    if (!samplingStopped && !daemonMissing) probe.finish()
    else probe.stop()
    const dayResult = await dayDriver?.stop() ?? { switches: [], phases: [], taskInteractions: [], drainError: null }
    if (interrupted) return interrupted
    const durationSeconds = Number(((measurementEnd - startedAt) / 1000).toFixed(3))
    if (attemptedSamples > 0 && skippedSamples / attemptedSamples > 0.1) {
      throw new Error(`ps failed for ${skippedSamples} of ${attemptedSamples} samples`)
    }
    const faultRecord = fault ? await fault.finish() : null
    if (config.fault === 'feedback') {
      const observed = panelRefreshes.filter(({ method }) => method === 'soak.faults/feedbackRefresh')
      if (observed.length !== 17) throw new Error(`feedback observed ${observed.length} panel refreshes, expected 17`)
      if (Math.round(observed.at(-1)!.at * 1000) - Math.round(observed[0]!.at * 1000) > 5_000) {
        throw new Error('feedback observed panel refreshes span more than five seconds')
      }
      if (observed.some(({ worktree, index }, sequence) => index !== sequence % 2 || worktree !== feedbackWorktrees![sequence % 2])) {
        throw new Error('feedback observed panel refreshes did not alternate the ready window pair')
      }
      const events = probe.events.filter(({ type }) => type === 'soak.faults/feedbackChanged')
      if (events.length !== 17) throw new Error(`feedback observed ${events.length} changed events, expected 17`)
    }
    const windowEvidence = windows ? await windows.finish() : { records: [], requests: [] }
    if (config.fault === 'flood') {
      if (floodObservationError) throw new Error(`flood observed ${floodObservationError}`)
      if (floodObserved !== 3000 || floodSequences.size !== 3000) {
        throw new Error(`flood observed ${floodObserved} ticks (${floodSequences.size} unique), expected 3000`)
      }
      const completed = faultRecord?.detail.flood
      if (!completed || completed.requests !== 3000 || completed.index !== floodWindow!.index
        || completed.worktree !== floodWindow!.worktree) {
        throw new Error('flood observed ticks do not match the completed fixture')
      }
      const events = probe.events.filter(({ type }) => type === 'soak.faults/floodStarted')
      if (events.length !== 1) throw new Error(`flood observed ${events.length} started events, expected 1`)
    }
    if (interrupted) return interrupted
    const now = Date.now()
    const daemonLog = readFileSync(join(config.out, 'daemon.log'), 'utf8')
    const skippedBeatCount = countSkippedBeats(world.workers)
    const evidence = {
      startedAt: startedIso,
      durationSeconds,
      windows: windowEvidence.records.filter(windowAlive).length,
      windowBeats: windowEvidence.records,
      samples,
      events: probe.events,
      panelRefreshes,
      probes: probe.probes,
      gitProbes: probe.gitProbes,
      terminalProbes: probe.terminalProbes,
      windowRequestSeconds,
      panelRequests,
      day,
      switches: dayResult.switches,
      phases: dayResult.phases,
      taskInteractions: dayResult.taskInteractions,
      dayDrainError: dayResult.drainError,
      workers: world.workers.map(({ worktree, path }) => heartbeat(worktree, path, now)),
      daemonExited: daemonMissing || probe.daemonExited(),
      daemonLog,
    }
    const judged = judge(evidence, config)
    const rss = samples.flatMap(({ daemonRssKb }) => daemonRssKb === null ? [] : [daemonRssKb])
    const report: SoakReport = {
      version: 1,
      commit: revision,
      startedAt: startedIso,
      durationSeconds,
      config: {
        minutes: config.minutes,
        windows: config.windows,
        worktrees: world.fixtures.worktrees.length,
        workers: world.workers.length,
        limits: config.limits,
        slowGitMs: config.slowGitMs ?? null,
      },
      ...judged,
      fault: faultRecord,
      windows: windowEvidence.records,
      windowRequests: windowEvidence.requests,
      panelRefreshes,
      gitProbes: probe.gitProbes,
      terminalProbes: probe.terminalProbes,
      windowRequestSeconds,
      panelRequests,
      day: day ?? null,
      switches: dayResult.switches,
      phases: dayResult.phases,
      taskInteractions: dayResult.taskInteractions,
      daemon: { pid: world.daemonPid, rssKbFirst: rss[0] ?? null, rssKbMax: rss.length ? Math.max(...rss) : null, rssKbLast: rss.at(-1) ?? null },
      skippedSamples,
      skippedBeats: skippedBeatCount,
      files: { samples: samplesPath, daemonLog: join(config.out, 'daemon.log') }
    }
    writeFileSync(join(config.out, 'soak-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(config.out)
    for (const [name, check] of Object.entries(report.checks)) console.log(`${name}: ${check.ok ? 'pass' : 'fail'} ${JSON.stringify(check)}`)
    if (report.fault) console.log(`fault ${report.fault.kind}: injected at ${report.fault.at}s, aimed at ${report.fault.check}`)
    return report.verdict === 'pass' ? 0 : 1
  } catch (error) {
    rmSync(join(config.out, 'soak-report.json'), { force: true })
    if (interrupted) return interrupted
    const message = error instanceof Error ? error.message : String(error)
    console.error(world ? message.replaceAll(world.home, '<soak-home>') : message)
    if (error instanceof UsageError) console.error(USAGE)
    return 2
  } finally {
    probe?.stop()
    fault?.stop()
    try {
      await fault?.settled()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
    try {
      try {
        await dayDriver?.stop()
        await windows?.stop()
      } finally {
        await world?.stop()
      }
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

import { chmodSync, copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { FAULT_CHECK, type FaultKind, type FaultRecord } from './contracts.ts'

export const FAULT_PLUGIN_ID = 'soak.faults'
export const FAULT_ENV = 'QUIRKY_SOAK_FAULTS'
export const FAULT_DELAY_SECONDS = 2
export const SLOW_GIT_FILE = 'soak-git-delay-ms'
export const SLOW_GIT_PIDS = 'slow-git.pids'
export const SLOW_GIT_FAULT_MS = 35_000

export type FaultPlan =
  | { kind: 'leak'; count: number; everyMs: number; lifetimeSeconds: number }
  | { kind: 'zombies'; holders: number; each: number; lifetimeSeconds: number }
  | { kind: 'storm'; seconds: number }
  | { kind: 'block'; ms: number }
  | { kind: 'slow-git'; ms: number }
  | { kind: 'feedback'; refreshes: number }
  | { kind: 'flood'; requests: 3000 }
type PluginReport = { leaked: number[]; holders: number[]; refreshes: number; blockedMs: number | null }

/** Returns bounded parameters that trip the chosen check on a run of this length. */
export function faultPlan(kind: FaultKind, runSeconds: number): FaultPlan {
  const lifetimeSeconds = Math.min(86_400, Math.ceil(runSeconds) + 30)
  switch (kind) {
    case 'leak': return { kind, count: 80, everyMs: Math.max(10, Math.min(60_000, Math.round(runSeconds * 0.6 * 1000 / 80))), lifetimeSeconds }
    case 'zombies': return { kind, holders: 2, each: 5, lifetimeSeconds }
    case 'storm': return { kind, seconds: 10 }
    case 'block': return { kind, ms: 3000 }
    case 'slow-git': return { kind, ms: SLOW_GIT_FAULT_MS }
    case 'feedback': return { kind, refreshes: 17 }
    case 'flood': return { kind, requests: 3000 }
  }
}

/** Copies the guarded fault plugin into the disposable daemon's discovery directory. */
export function installFaultPlugin(home: string, repoRoot: string): void {
  const destination = join(home, 'plugins', FAULT_PLUGIN_ID)
  mkdirSync(destination, { recursive: true })
  for (const file of ['quirky-plugin.json', 'main.ts']) {
    copyFileSync(join(repoRoot, 'scripts', 'soak', 'faults', file), join(destination, file))
  }
}

/** Builds the passive fixture panel into the disposable plugin tree. */
export async function buildFaultUi(home: string, repoRoot: string): Promise<void> {
  const plugin = join(home, 'plugins', FAULT_PLUGIN_ID)
  const source = join(repoRoot, 'scripts', 'soak', 'faults', 'ui.tsx')
  const sourceCopy = join(plugin, 'src', 'ui.tsx')
  const output = join(plugin, 'dist')
  mkdirSync(join(plugin, 'src'), { recursive: true })
  copyFileSync(source, sourceCopy)
  const result = await Bun.build({
    entrypoints: [source],
    target: 'browser',
    minify: true,
    splitting: true,
    outdir: output,
    define: { 'process.env.NODE_ENV': '"production"' },
    throw: false,
    naming: { entry: 'ui.[ext]', chunk: 'chunk-[hash].[ext]', asset: 'asset-[hash].[ext]' },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
  })
  if (!result.success) {
    const diagnostics = result.logs.map((log) => log.message).join('\n')
    throw new Error(`feedback fixture UI build failed${diagnostics ? `: ${diagnostics}` : ''}`)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Installs a git wrapper that delays only worktree listings when the delay file is present. */
export function installSlowGit(home: string, path: string, pidFile: string): void {
  const realGit = Bun.which('git', { PATH: path })
  if (!realGit) throw new Error('could not locate git for the slow-git wrapper')

  const fakebin = join(home, 'fakebin')
  const delayFile = join(home, SLOW_GIT_FILE)
  const wrapperPath = join(fakebin, 'git')
  mkdirSync(fakebin, { recursive: true, mode: 0o700 })
  const source = [
    '#!/bin/sh',
    `if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ -f ${shellQuote(delayFile)} ]; then`,
    `  IFS= read -r delay < ${shellQuote(delayFile)}`,
    '  case "$delay" in \'\'|*[!0-9]*) delay=0 ;; esac',
    '  if [ "$delay" -gt 0 ]; then',
    `    printf '%s\\n' "$$" >> ${shellQuote(pidFile)}`,
    '    seconds=$((delay / 1000))',
    '    millis=$((delay % 1000))',
    '    sleep "$seconds.$(printf \'%03d\' "$millis")"',
    '  fi',
    'fi',
    `exec ${shellQuote(realGit)} "$@"`,
    ''
  ].join('\n')
  writeFileSync(wrapperPath, source, { mode: 0o700 })
  chmodSync(wrapperPath, 0o700)
}

export function setGitDelay(home: string, ms: number): void {
  writeFileSync(join(home, SLOW_GIT_FILE), `${ms}\n`)
}

function readSlowGitPids(out: string): number[] {
  let text: string
  try {
    text = readFileSync(join(out, SLOW_GIT_PIDS), 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return text.split(/\r?\n/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

export type RunningFault = {
  /** Reads the final fault evidence, rejecting missing injections and failed calls. */
  finish(): Promise<FaultRecord>
  /** Stops client-driven faults and prevents further calls, including after abort. */
  stop(): void
}

/** Injects one real-daemon fault after a clean probe interval, without owning daemon cleanup. */
export function startFault(options: {
  kind: FaultKind; home: string; control: QuirkyClient; projects: string[]; out: string
  runSeconds: number; startedAt: number; signal: AbortSignal; feedbackWorktrees?: [string, string]
  floodWindow?: { index: number; worktree: string }
}): RunningFault {
  const isWorktreePair = (value: unknown): value is [string, string] =>
    Array.isArray(value) && value.length === 2 && value.every((worktree) => typeof worktree === 'string' && worktree.trim() !== '')
  const sameWorktrees = (value: unknown, expected: [string, string]) =>
    isWorktreePair(value) && value[0] === expected[0] && value[1] === expected[1]
  const isFloodWindow = (value: unknown): value is { index: number; worktree: string } => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const target = value as Record<string, unknown>
    return typeof target.index === 'number' && Number.isSafeInteger(target.index) && target.index >= 0
      && typeof target.worktree === 'string' && target.worktree.trim() !== ''
  }
  const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
  if (options.kind === 'feedback' && (!isWorktreePair(options.feedbackWorktrees) || options.feedbackWorktrees[0] === options.feedbackWorktrees[1])) {
    throw new Error('feedback fault requires two distinct nonempty worktrees')
  }
  const feedbackWorktrees = options.feedbackWorktrees ? [...options.feedbackWorktrees] as [string, string] : undefined
  let floodWindow: { index: number; worktree: string } | undefined
  if (options.kind === 'flood') {
    if (!isFloodWindow(options.floodWindow)) {
      throw new Error('flood fault requires a nonnegative window index and nonempty worktree')
    }
    floodWindow = { index: options.floodWindow.index, worktree: options.floodWindow.worktree }
  }
  const plan = faultPlan(options.kind, options.runSeconds)
  let stopped = false
  let driversStopped = false
  let at: number | undefined
  let failure: unknown
  let failed = false
  let finalization: Promise<FaultRecord> | undefined
  const drivers: QuirkyClient[] = []
  const unsubscribes: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const cancellation = Promise.withResolvers<void>()

  const closeDrivers = () => {
    driversStopped = true
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
    for (const client of drivers.splice(0)) client.close()
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    cancellation.resolve()
    clearTimeout(timer)
    wake?.()
    closeDrivers()
    options.signal.removeEventListener('abort', stop)
  }
  options.signal.addEventListener('abort', stop, { once: true })
  if (options.signal.aborted) stop()

  const ensureRunning = () => {
    if (stopped) throw new Error('soak fault was stopped before completion')
  }
  const untilStopped = <T>(task: Promise<T>): Promise<T> => Promise.race([
    task,
    cancellation.promise.then((): never => { throw new Error('soak fault was stopped before completion') })
  ])
  const call = (client: QuirkyClient, method: string, params: Record<string, unknown>, timeoutMs = 30_000) => {
    ensureRunning()
    return client.callAny(`${FAULT_PLUGIN_ID}/${method}`, params, { timeoutMs })
  }
  const pause = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    if (stopped) resolve()
    else {
      wake = resolve
      timer = setTimeout(() => { wake = undefined; resolve() }, Math.max(0, Math.ceil(ms)))
    }
    return promise
  }
  const recordFailure = (error: unknown) => {
    if (!failed) { failed = true; failure = error }
    closeDrivers()
  }

  const injectFeedback = async (worktrees: [string, string]) => {
    const connecting = connectDaemon({
      home: options.home,
      role: 'cli',
      name: 'soak-feedback-monitor',
      subscribe: true,
      autostart: false
    }).then((client) => {
      if (stopped) {
        client.close()
        ensureRunning()
      }
      return client
    })
    let monitor: QuirkyClient
    try {
      monitor = await untilStopped(connecting)
    } catch (error) {
      ensureRunning()
      throw new Error(`feedback event monitor failed to connect: ${messageOf(error)}`, { cause: error })
    }
    drivers.push(monitor)

    const completion = Promise.withResolvers<void>()
    let completionFailure: Error | undefined
    let startedEvents = 0
    let changedEvents = 0
    let firstChangedAt: number | undefined
    const fail = (message: string) => {
      if (completionFailure) return
      completionFailure = new Error(message)
      completion.resolve()
    }
    unsubscribes.push(monitor.onEvent((event) => {
      if (stopped || driversStopped) return
      if (event.type === `${FAULT_PLUGIN_ID}/feedbackStarted`) {
        const data = event.data as { worktrees?: unknown; first?: unknown } | undefined
        startedEvents += 1
        if (startedEvents !== 1 || !sameWorktrees(data?.worktrees, worktrees) || data?.first !== worktrees[0]) {
          fail('feedbackStarted event did not arm the requested worktree pair exactly once')
        }
        return
      }
      if (event.type !== `${FAULT_PLUGIN_ID}/feedbackChanged`) return
      const data = event.data as { worktrees?: unknown; owner?: unknown; sequence?: unknown } | undefined
      const expectedSequence = changedEvents + 1
      const expectedOwner = expectedSequence % 2 === 1 ? worktrees[0] : worktrees[1]
      if (startedEvents !== 1 || !sameWorktrees(data?.worktrees, worktrees)
        || data?.sequence !== expectedSequence || data?.owner !== expectedOwner) {
        fail(`feedbackChanged event ${expectedSequence} did not match the armed owner sequence`)
        return
      }
      const now = performance.now()
      firstChangedAt ??= now
      if (now - firstChangedAt > 5000) {
        fail('feedbackChanged events exceeded the five-second injection window')
        return
      }
      changedEvents = expectedSequence
      if (changedEvents === 17) completion.resolve()
    }))
    const deadline = setTimeout(() => fail('feedback fixture did not complete all 17 feedbackChanged events'), 10_000)
    try {
      at = (performance.now() - options.startedAt) / 1000
      let started: unknown
      try {
        started = await untilStopped(call(options.control, 'feedbackStart', { worktrees }))
      } catch (error) {
        ensureRunning()
        throw new Error(`feedbackStart RPC failed: ${messageOf(error)}`, { cause: error })
      }
      ensureRunning()
      if (typeof started !== 'object' || started === null || !('started' in started) || started.started !== true) {
        throw new Error('feedbackStart RPC did not confirm that the fixture started')
      }
      await untilStopped(completion.promise)
      ensureRunning()
      if (completionFailure) throw completionFailure
      if (startedEvents !== 1 || changedEvents !== 17) {
        throw new Error(`feedback fixture completed ${changedEvents} of 17 feedbackChanged events`)
      }
    } finally {
      clearTimeout(deadline)
      closeDrivers()
    }
  }

  const injectFlood = async (window: { index: number; worktree: string }, requests: number) => {
    const deadlineAt = performance.now() + 10_000
    const deadline = Promise.withResolvers<never>()
    const deadlineTimer = setTimeout(
      () => deadline.reject(new Error('flood injection did not complete within 10 seconds')),
      10_000
    )
    const withinDeadline = <T>(task: Promise<T>) => untilStopped(Promise.race([task, deadline.promise]))
    const timeoutMs = () => {
      const remaining = deadlineAt - performance.now()
      if (remaining <= 0) throw new Error('flood injection did not complete within 10 seconds')
      return Math.ceil(remaining)
    }
    const callFlood = async (method: string, params: Record<string, unknown>) => {
      let raw: unknown
      try {
        raw = await withinDeadline(call(options.control, method, params, timeoutMs()))
      } catch (error) {
        ensureRunning()
        throw new Error(`${method} RPC failed: ${messageOf(error)}`, { cause: error })
      }
      ensureRunning()
      return raw
    }
    const hasExactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

    try {
      at = (performance.now() - options.startedAt) / 1000
      const started = await callFlood('floodStart', { worktree: window.worktree, requests })
      if (!hasExactKeys(started, ['started']) || started.started !== true) {
        throw new Error('floodStart RPC did not confirm that the fixture started')
      }

      while (true) {
        const raw = await callFlood('floodReport', {})
        if (!hasExactKeys(raw, ['worktree', 'expected', 'requests', 'active'])
          || raw.worktree !== window.worktree
          || raw.expected !== requests
          || typeof raw.requests !== 'number'
          || !Number.isSafeInteger(raw.requests)
          || raw.requests < 0
          || raw.requests > requests
          || typeof raw.active !== 'boolean') {
          throw new Error('floodReport did not match the armed target')
        }
        if (raw.requests === requests && raw.active === false) return
        if (raw.requests === requests || raw.active === false) {
          throw new Error('floodReport did not match the armed target')
        }
        await withinDeadline(pause(Math.min(100, Math.max(0, deadlineAt - performance.now()))))
        ensureRunning()
      }
    } finally {
      clearTimeout(deadlineTimer)
    }
  }

  const inject = async () => {
    const deadline = options.startedAt + FAULT_DELAY_SECONDS * 1000
    while (!stopped && performance.now() < deadline) await pause(deadline - performance.now())
    ensureRunning()
    if (plan.kind === 'flood') {
      await injectFlood(floodWindow!, plan.requests)
    } else if (plan.kind === 'feedback') {
      await injectFeedback(feedbackWorktrees!)
    } else if (plan.kind === 'slow-git') {
      setGitDelay(options.home, plan.ms)
      const now = new Date()
      for (const project of options.projects) utimesSync(join(project, '.git', 'config'), now, now)
      at = (performance.now() - options.startedAt) / 1000
    } else if (plan.kind === 'storm') {
      for (const owner of ['a', 'b']) {
        const client = await connectDaemon({ home: options.home, role: 'cli', name: `soak-fault-${owner}`, subscribe: true, autostart: false })
        if (stopped) { client.close(); ensureRunning() }
        drivers.push(client)
        unsubscribes.push(client.onEvent((event) => {
          if (stopped || driversStopped || event.type !== `${FAULT_PLUGIN_ID}/changed`) return
          const data = event.data as { owner?: unknown } | undefined
          if (data?.owner === owner) return
          void call(client, 'refresh', { owner }).catch((error: unknown) => {
            if (!stopped && !driversStopped) recordFailure(error)
          })
        }))
      }
      at = (performance.now() - options.startedAt) / 1000
      await call(drivers[0]!, 'refresh', { owner: 'a' })
      await pause(plan.seconds * 1000)
      closeDrivers()
    } else {
      const { kind, ...params } = plan
      at = (performance.now() - options.startedAt) / 1000
      await call(options.control, kind, params)
    }
  }
  const injected = inject().catch(recordFailure)

  const finalize = async (): Promise<FaultRecord> => {
    if (failed) throw failure
    if (at === undefined) throw new Error('soak fault was not injected before the run ended')
    await untilStopped(injected)
    ensureRunning()
    if (failed) throw failure
    if (options.kind === 'flood') {
      return {
        kind: options.kind,
        check: FAULT_CHECK[options.kind],
        at: Number(at.toFixed(3)),
        detail: {
          pids: [],
          refreshes: 0,
          blockedMs: null,
          flood: { ...floodWindow!, requests: 3000 }
        }
      }
    }
    if (options.kind === 'feedback') {
      let raw: unknown
      try {
        raw = await untilStopped(call(options.control, 'feedbackReport', {}))
      } catch (error) {
        ensureRunning()
        throw new Error(`feedbackReport RPC failed: ${messageOf(error)}`, { cause: error })
      }
      ensureRunning()
      const report = raw as { worktrees?: unknown; refreshes?: unknown; active?: unknown } | null
      if (!report || !sameWorktrees(report.worktrees, feedbackWorktrees!)
        || report.refreshes !== 17 || report.active !== false) {
        throw new Error(`feedbackReport confirmed ${String(report?.refreshes)} refreshes; expected 17 completed refreshes and an inactive fixture`)
      }
      return {
        kind: options.kind,
        check: FAULT_CHECK[options.kind],
        at: Number(at.toFixed(3)),
        detail: { pids: [], refreshes: report.refreshes, blockedMs: null, worktrees: feedbackWorktrees }
      }
    }
    const report = await untilStopped(call(options.control, 'report', {})) as PluginReport
    ensureRunning()
    return {
      kind: options.kind,
      check: FAULT_CHECK[options.kind],
      at: Number(at.toFixed(3)),
      detail: {
        pids: options.kind === 'leak'
          ? report.leaked
          : options.kind === 'zombies'
            ? report.holders
            : options.kind === 'slow-git'
              ? readSlowGitPids(options.out)
              : [],
        refreshes: report.refreshes,
        blockedMs: report.blockedMs
      }
    }
  }

  return {
    stop,
    finish() {
      finalization ??= finalize()
      return finalization
    }
  }
}

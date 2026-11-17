import { chmodSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { FAULT_CHECK, type FaultKind, type FaultRecord, type ProcessRow } from './contracts.ts'
import { parseProcessTable } from './processes.ts'

export const FAULT_PLUGIN_ID = 'soak.faults'
export const FAULT_ENV = 'QUIRKY_SOAK_FAULTS'
export const FAULT_DELAY_SECONDS = 2
export const SLOW_GIT_FILE = 'soak-git-delay-ms'
export const SLOW_GIT_PIDS = 'slow-git.pids'
export const SLOW_GIT_FAULT_MS = 35_000
export const PTY_PAUSE_MS = 3000

const PROCESS_INSPECTION_BUDGET_MS = 2000
const RESUME_DEADLINE_MS = 5000
const INSPECT_RETRY_MS = 100
const CONT_SETTLE_MS = 1000
const CONT_POLL_MS = 50
const CONT_ATTEMPTS = 3
const KILL_SETTLE_MS = 2000

export type PtyHostIdentity = {
  pid: number
  started: string
  command: string
  state: string
  cwd: string
  home: string | null
}

export type PtyHostInspection =
  | { kind: 'present'; identity: PtyHostIdentity }
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: string }

export type PtyPauseOutcome = 'resumed' | 'lost' | 'killed' | 'unverified' | 'not-applied'

export type PtyPauseDependencies = {
  inspect?: (pid: number) => PtyHostInspection
  kill?: (pid: number, signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL') => void
  now?: () => number
  holdMs?: number
  resumeDeadlineMs?: number
}

export type FaultPlan =
  | { kind: 'leak'; count: number; everyMs: number; lifetimeSeconds: number }
  | { kind: 'zombies'; holders: number; each: number; lifetimeSeconds: number }
  | { kind: 'storm'; seconds: number }
  | { kind: 'block'; ms: number }
  | { kind: 'slow-git'; ms: number }
  | { kind: 'feedback'; refreshes: number }
  | { kind: 'flood'; requests: 3000 }
  | { kind: 'pty-pause'; ms: number }
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
    case 'pty-pause': return { kind, ms: PTY_PAUSE_MS }
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

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) return String(error.code)
  return error instanceof Error ? error.message : String(error)
}

function unreadablePtyHost(pid: number, reason: string): PtyHostInspection {
  return { kind: 'unreadable', reason: `could not inspect PTY host ${pid}: ${reason}` }
}

function confirmPtyHostAbsent(pid: number, reason: string): PtyHostInspection {
  try {
    process.kill(pid, 0)
    return unreadablePtyHost(pid, reason)
  } catch (error) {
    return errorCode(error) === 'ESRCH'
      ? { kind: 'absent' }
      : unreadablePtyHost(pid, `${reason}; kill(pid, 0) failed: ${errorCode(error)}`)
  }
}

function ptyHomeFromEnvironment(environment: string, separator: '\0' | ' '): string | null {
  const variable = environment.split(separator).find((entry) => entry.startsWith('QUIRKY_HOME='))
  return variable === undefined ? null : variable.slice('QUIRKY_HOME='.length)
}

function ptyHomeFromDarwinCommand(commandLine: string, processCommand: string): string | null {
  const command = commandLine.trim()
  if (!command || !processCommand || !command.startsWith(processCommand)) throw new Error('ps eww returned no command')
  const environment = command.slice(processCommand.length)
  if (environment !== '' && !environment.startsWith(' ')) throw new Error('ps eww command did not end at an environment boundary')
  return ptyHomeFromEnvironment(environment, ' ')
}

/** Reads one PTY-host identity synchronously under a shared two-second subprocess budget. */
export function inspectPtyHost(pid: number): PtyHostInspection {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return unreadablePtyHost(pid, `unsupported platform ${process.platform}`)
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    return errorCode(error) === 'ESRCH'
      ? { kind: 'absent' }
      : unreadablePtyHost(pid, `kill(pid, 0) failed: ${errorCode(error)}`)
  }

  const deadline = performance.now() + PROCESS_INSPECTION_BUDGET_MS
  const run = (command: string[]): string => {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw new Error('shared process inspection budget expired')
    const result = Bun.spawnSync(command, {
      env: { ...process.env, LC_ALL: 'C' },
      timeout: remaining
    })
    if (result.exitCode !== 0) {
      throw new Error(`${command[0]} exited with ${result.exitCode}${result.stderr.length ? `: ${result.stderr.toString().trim()}` : ''}`)
    }
    return result.stdout.toString()
  }

  let row: ProcessRow | undefined
  try {
    row = parseProcessTable(run(['ps', '-o', 'pid=,ppid=,stat=,rss=,lstart=,command=', '-p', String(pid)]))
      .find((candidate) => candidate.pid === pid)
    if (!row) return confirmPtyHostAbsent(pid, 'ps returned no parseable process row')

    let cwd: string
    let home: string | null
    if (process.platform === 'darwin') {
      const cwdOutput = run(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      const cwdLine = cwdOutput.split(/\r?\n/).find((line) => line.startsWith('n'))
      if (!cwdLine || cwdLine.length === 1) throw new Error('lsof returned no cwd path')
      cwd = cwdLine.slice(1)
      const environment = run(['ps', 'eww', '-p', String(pid), '-o', 'command='])
      if (!environment.trim() || !environment.includes(row.command)) throw new Error('ps eww returned no valid command row')
      home = ptyHomeFromDarwinCommand(environment, row.command)
    } else {
      cwd = readlinkSync(`/proc/${pid}/cwd`)
      const environment = readFileSync(`/proc/${pid}/environ`).toString('utf8')
      if (environment.split('\0').some((entry) => entry !== '' && !entry.includes('='))) {
        throw new Error('/proc environ returned malformed environment data')
      }
      home = ptyHomeFromEnvironment(environment, '\0')
    }
    return {
      kind: 'present',
      identity: {
        pid: row.pid,
        started: row.started,
        command: row.command,
        state: row.state,
        cwd,
        home
      }
    }
  } catch (error) {
    return confirmPtyHostAbsent(pid, error instanceof Error ? error.message : String(error))
  }
}

/** Returns the real entry path used to identify a PTY host from this checkout. */
export function ptyHostEntry(repoRoot: string): string {
  return realpathSync(join(repoRoot, 'packages', 'pty-host', 'src', 'main.ts'))
}

/** Returns the first ownership rule that the inspected PTY host fails, or null when it is owned. */
export function ownsPtyHost(identity: PtyHostIdentity, owner: { home: string; entry: string }): string | null {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'pid is not a safe positive integer'
  if (identity.pid === process.pid) return 'pid is the soak runner itself'
  if (identity.state.startsWith('T')) return 'host is already stopped'
  if (!identity.command.endsWith(` ${owner.entry}`)) return 'command does not end with the PTY host entry'
  try {
    if (realpathSync(identity.cwd) !== realpathSync(owner.home)) return 'cwd does not match the run home'
  } catch {
    return 'cwd or run home cannot be resolved'
  }
  if (identity.home !== owner.home) return 'QUIRKY_HOME does not match the run home'
  return null
}

/** Compares a PTY host's stable process identity, ignoring its transient state. */
export function sameHost(left: PtyHostIdentity, right: PtyHostIdentity): boolean {
  return left.pid === right.pid
    && left.started === right.started
    && left.command === right.command
    && left.cwd === right.cwd
    && left.home === right.home
}

export type RunningFault = {
  /** Reads the final fault evidence, rejecting missing injections and failed calls. */
  finish(): Promise<FaultRecord>
  /** Stops client-driven faults and prevents further calls, including after abort. */
  stop(): void
  /** Resolves when a PTY pause no longer owns cleanup; other fault kinds resolve to null immediately. */
  settled(): Promise<PtyPauseOutcome | null>
}

/** Injects one real-daemon fault after a clean probe interval, without owning daemon cleanup. */
export function startFault(options: {
  kind: FaultKind; home: string; control: QuirkyClient; projects: string[]; out: string
  runSeconds: number; startedAt: number; signal: AbortSignal; feedbackWorktrees?: [string, string]
  floodWindow?: { index: number; worktree: string }
  repoRoot?: string; ptyHostPid?: () => number | null; ptyPause?: PtyPauseDependencies
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
  const ptyPauseCompletion = plan.kind === 'pty-pause' ? Promise.withResolvers<PtyPauseOutcome>() : undefined
  const settled: Promise<PtyPauseOutcome | null> = ptyPauseCompletion?.promise ?? Promise.resolve(null)
  let ptyOutcome: PtyPauseOutcome | undefined
  let ptyStopSent = false
  let ptyStoppedAt: number | undefined
  let ptyBlockedMs: number | undefined
  let ptyHost: { pid: number; identity: PtyHostIdentity } | undefined
  let ptyResumePromise: Promise<PtyPauseOutcome> | undefined
  let ptyHoldTimer: ReturnType<typeof setTimeout> | undefined
  let ptyHoldResolve: (() => void) | undefined
  let ptyExitHandler: (() => void) | undefined
  let beginPtyResume: (() => Promise<PtyPauseOutcome> | undefined) | undefined

  const settlePtyPause = (outcome: PtyPauseOutcome) => {
    if (ptyOutcome !== undefined) return
    ptyOutcome = outcome
    if (ptyExitHandler) process.removeListener('exit', ptyExitHandler)
    ptyPauseCompletion?.resolve(outcome)
  }

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
    if (ptyStopSent) void beginPtyResume?.()
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
  const inspectForPause = (pid: number): PtyHostInspection => {
    try {
      return options.ptyPause?.inspect?.(pid) ?? inspectPtyHost(pid)
    } catch (error) {
      return { kind: 'unreadable', reason: messageOf(error) }
    }
  }
  const sendPtySignal: NonNullable<PtyPauseDependencies['kill']> = (pid, signal) => {
    if (options.ptyPause?.kill) options.ptyPause.kill(pid, signal)
    else process.kill(pid, signal)
  }
  const measurementNow = () => options.ptyPause?.now?.() ?? performance.now()

  const resumePtyHost = async (): Promise<PtyPauseOutcome> => {
    const host = ptyHost
    if (!host) {
      settlePtyPause('unverified')
      return 'unverified'
    }
    const deadline = performance.now() + Math.max(0, options.ptyPause?.resumeDeadlineMs ?? RESUME_DEADLINE_MS)
    let continueAttempts = 0
    let killAttempted = false
    let killWindowEnd = 0

    const finishPause = (outcome: PtyPauseOutcome): PtyPauseOutcome => {
      settlePtyPause(outcome)
      return outcome
    }
    const warnUnverified = (): PtyPauseOutcome => {
      try {
        process.stderr.write(`pty-pause could not confirm the PTY host left the stopped state: pid ${host.pid} started ${host.identity.started}\n`)
      } catch {}
      return finishPause('unverified')
    }
    const sleepAtMost = async (end: number, interval: number) => {
      const remaining = end - performance.now()
      if (remaining > 0) await Bun.sleep(Math.min(interval, remaining))
    }

    while (true) {
      if (performance.now() >= deadline) return warnUnverified()
      const current = inspectForPause(host.pid)
      if (current.kind === 'absent') return finishPause(killAttempted ? 'killed' : 'lost')
      if (current.kind === 'unreadable') {
        await sleepAtMost(deadline, INSPECT_RETRY_MS)
        continue
      }
      if (!sameHost(host.identity, current.identity)) return finishPause('lost')
      if (killAttempted) {
        const retryAt = performance.now() < killWindowEnd ? killWindowEnd : deadline
        await sleepAtMost(retryAt, CONT_POLL_MS)
        continue
      }
      if (!current.identity.state.startsWith('T')) {
        ptyBlockedMs = Math.max(0, performance.now() - (ptyStoppedAt ?? performance.now()))
        return finishPause('resumed')
      }
      if (continueAttempts >= CONT_ATTEMPTS) {
        killAttempted = true
        killWindowEnd = Math.min(deadline, performance.now() + KILL_SETTLE_MS)
        try { sendPtySignal(host.pid, 'SIGKILL') } catch {}
        await sleepAtMost(killWindowEnd, CONT_POLL_MS)
        continue
      }

      continueAttempts += 1
      try {
        sendPtySignal(host.pid, 'SIGCONT')
      } catch (error) {
        if (errorCode(error) === 'ESRCH') continue
        continue
      }

      const settleDeadline = Math.min(deadline, performance.now() + CONT_SETTLE_MS)
      while (performance.now() < settleDeadline) {
        await sleepAtMost(settleDeadline, CONT_POLL_MS)
        if (performance.now() >= deadline || performance.now() >= settleDeadline) break
        const poll = inspectForPause(host.pid)
        if (poll.kind === 'absent') return finishPause('lost')
        if (poll.kind === 'unreadable') continue
        if (!sameHost(host.identity, poll.identity)) return finishPause('lost')
        if (!poll.identity.state.startsWith('T')) {
          ptyBlockedMs = Math.max(0, performance.now() - (ptyStoppedAt ?? performance.now()))
          return finishPause('resumed')
        }
      }
    }
  }

  beginPtyResume = () => {
    if (!ptyStopSent) return undefined
    if (ptyResumePromise) return ptyResumePromise
    if (ptyOutcome !== undefined) return Promise.resolve(ptyOutcome)

    const completion = Promise.withResolvers<PtyPauseOutcome>()
    ptyResumePromise = completion.promise
    clearTimeout(ptyHoldTimer)
    ptyHoldTimer = undefined
    const releaseHold = ptyHoldResolve
    ptyHoldResolve = undefined
    releaseHold?.()
    void resumePtyHost().then(completion.resolve, () => {
      if (ptyHost) {
        try {
          process.stderr.write(`pty-pause could not confirm the PTY host left the stopped state: pid ${ptyHost.pid} started ${ptyHost.identity.started}\n`)
        } catch {}
      }
      settlePtyPause('unverified')
      completion.resolve('unverified')
    })
    return ptyResumePromise
  }

  const registerPtyExitHandler = () => {
    const onExit = () => {
      const host = ptyHost
      if (!ptyStopSent || !host || ptyOutcome !== undefined) return
      for (let round = 0; round < CONT_ATTEMPTS; round += 1) {
        const current = inspectForPause(host.pid)
        if (current.kind === 'absent') {
          settlePtyPause('lost')
          return
        }
        if (current.kind === 'unreadable') continue
        if (!sameHost(host.identity, current.identity)) {
          settlePtyPause('lost')
          return
        }
        if (!current.identity.state.startsWith('T')) {
          ptyBlockedMs = Math.max(0, performance.now() - (ptyStoppedAt ?? performance.now()))
          settlePtyPause('resumed')
          return
        }
        try {
          sendPtySignal(host.pid, 'SIGCONT')
          return
        } catch (error) {
          if (errorCode(error) === 'ESRCH') continue
        }
      }
    }
    ptyExitHandler = onExit
    process.on('exit', onExit)
  }

  const injectPtyPause = async () => {
    const notApplied = (reason: string): never => {
      settlePtyPause('not-applied')
      throw new Error(`pty-pause fault not applied: ${reason}`)
    }
    try {
      ensureRunning()
      const repoRoot = options.repoRoot
      const getPtyHostPid = options.ptyHostPid
      if (!repoRoot) notApplied('repo root is unavailable')
      if (!getPtyHostPid) notApplied('tracked PTY host PID is unavailable')

      let rawStatus: unknown
      try {
        rawStatus = await untilStopped(options.control.callAny('status.get', {}, { timeoutMs: 30_000 }))
      } catch (error) {
        ensureRunning()
        notApplied(`status.get failed: ${messageOf(error)}`)
      }
      ensureRunning()
      const statusRecord = typeof rawStatus === 'object' && rawStatus !== null
        ? rawStatus as { ptyHost?: unknown }
        : undefined
      const ptyRecord = typeof statusRecord?.ptyHost === 'object' && statusRecord.ptyHost !== null
        ? statusRecord.ptyHost as { pid?: unknown }
        : undefined
      const reportedPid = ptyRecord?.pid
      let trackedPid: number | null
      try {
        trackedPid = getPtyHostPid()
      } catch (error) {
        notApplied(`tracked PTY host lookup failed: ${messageOf(error)}`)
      }
      if (typeof reportedPid !== 'number' || !Number.isSafeInteger(reportedPid) || reportedPid <= 0
        || reportedPid !== trackedPid) {
        notApplied('status.get PTY host PID does not match the tracked host')
      }

      let entry: string
      try {
        entry = ptyHostEntry(repoRoot)
      } catch (error) {
        notApplied(`PTY host entry could not be resolved: ${messageOf(error)}`)
      }
      const owner = { home: options.home, entry }
      const captured = inspectForPause(reportedPid)
      if (captured.kind === 'absent') notApplied('PTY host is absent')
      if (captured.kind === 'unreadable') notApplied(captured.reason)
      const capturedReason = ownsPtyHost(captured.identity, owner)
      if (capturedReason) notApplied(capturedReason)

      const current = inspectForPause(reportedPid)
      if (current.kind === 'absent') notApplied('PTY host is absent before SIGSTOP')
      if (current.kind === 'unreadable') notApplied(current.reason)
      if (!sameHost(captured.identity, current.identity)) notApplied('PTY host identity changed before SIGSTOP')
      const currentReason = ownsPtyHost(current.identity, owner)
      if (currentReason) notApplied(currentReason)

      ptyHost = { pid: reportedPid, identity: captured.identity }
      registerPtyExitHandler()
      try {
        sendPtySignal(reportedPid, 'SIGSTOP')
      } catch (error) {
        if (ptyExitHandler) process.removeListener('exit', ptyExitHandler)
        ptyExitHandler = undefined
        ptyHost = undefined
        notApplied(`SIGSTOP failed: ${errorCode(error)}`)
      }
      ptyStopSent = true
      ptyStoppedAt = performance.now()

      try {
        const measuredStoppedAt = measurementNow()
        at = (measuredStoppedAt - options.startedAt) / 1000
        const hold = Promise.withResolvers<void>()
        ptyHoldResolve = hold.resolve
        ptyHoldTimer = setTimeout(() => {
          ptyHoldTimer = undefined
          ptyHoldResolve = undefined
          hold.resolve()
        }, Math.max(0, Math.ceil(options.ptyPause?.holdMs ?? PTY_PAUSE_MS)))
        await hold.promise
      } finally {
        await beginPtyResume?.()
      }
    } catch (error) {
      if (!ptyStopSent) settlePtyPause('not-applied')
      throw error
    }
  }

  const recordFailure = (error: unknown) => {
    if (!failed) { failed = true; failure = error }
    if (plan.kind === 'pty-pause' && !ptyStopSent) settlePtyPause('not-applied')
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
    if (plan.kind === 'pty-pause') {
      await injectPtyPause()
    } else if (plan.kind === 'flood') {
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
    if (plan.kind === 'pty-pause') {
      await beginPtyResume?.()
      await injected
      if (failed) throw failure
      const outcome = await settled
      if (outcome === 'lost') throw new Error('pty-pause host changed or exited during the pause')
      if (outcome === 'killed') throw new Error('pty-pause resume failed; host killed')
      if (outcome === 'unverified') throw new Error('pty-pause resume could not be verified')
      if (outcome === 'not-applied') throw new Error('pty-pause fault not applied: pause was not applied')
      if (outcome !== 'resumed') throw new Error('pty-pause resume did not reach a final outcome')
      if (at === undefined || ptyHost === undefined || ptyBlockedMs === undefined) {
        throw new Error('pty-pause resumed without complete fault evidence')
      }
      return {
        kind: 'pty-pause',
        check: FAULT_CHECK['pty-pause'],
        at: Number(at.toFixed(3)),
        detail: { pids: [ptyHost.pid], refreshes: 0, blockedMs: Math.round(ptyBlockedMs) }
      }
    }
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
    settled() {
      return settled
    },
    finish() {
      finalization ??= finalize()
      return finalization
    }
  }
}

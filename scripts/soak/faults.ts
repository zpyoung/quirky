import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { FAULT_CHECK, type FaultKind, type FaultRecord } from './contracts.ts'

export const FAULT_PLUGIN_ID = 'soak.faults'
export const FAULT_ENV = 'QUIRKY_SOAK_FAULTS'
export const FAULT_DELAY_SECONDS = 2

export type FaultPlan =
  | { kind: 'leak'; count: number; everyMs: number; lifetimeSeconds: number }
  | { kind: 'zombies'; holders: number; each: number; lifetimeSeconds: number }
  | { kind: 'storm'; seconds: number }
  | { kind: 'block'; ms: number }

type PluginReport = { leaked: number[]; holders: number[]; refreshes: number; blockedMs: number | null }

/** Returns bounded parameters that trip the chosen check on a run of this length. */
export function faultPlan(kind: FaultKind, runSeconds: number): FaultPlan {
  const lifetimeSeconds = Math.min(86_400, Math.ceil(runSeconds) + 30)
  switch (kind) {
    case 'leak': return { kind, count: 80, everyMs: Math.max(10, Math.min(60_000, Math.round(runSeconds * 0.6 * 1000 / 80))), lifetimeSeconds }
    case 'zombies': return { kind, holders: 2, each: 5, lifetimeSeconds }
    case 'storm': return { kind, seconds: 10 }
    case 'block': return { kind, ms: 3000 }
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

export type RunningFault = {
  /** Reads the final fault evidence, rejecting missing injections and failed calls. */
  finish(): Promise<FaultRecord>
  /** Stops client-driven faults and prevents further calls, including after abort. */
  stop(): void
}

/** Injects one real-daemon fault after a clean probe interval, without owning daemon cleanup. */
export function startFault(options: {
  kind: FaultKind; home: string; control: QuirkyClient
  runSeconds: number; startedAt: number; signal: AbortSignal
}): RunningFault {
  const plan = faultPlan(options.kind, options.runSeconds)
  let stopped = false
  let driversStopped = false
  let at: number | undefined
  let failure: unknown
  let failed = false
  const drivers: QuirkyClient[] = []
  const unsubscribes: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined

  const closeDrivers = () => {
    driversStopped = true
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
    for (const client of drivers.splice(0)) client.close()
  }
  const stop = () => {
    if (stopped) return
    stopped = true
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
  const call = (client: QuirkyClient, method: string, params: Record<string, unknown>) => {
    ensureRunning()
    return client.callAny(`${FAULT_PLUGIN_ID}/${method}`, params, { timeoutMs: 30_000 })
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
  const inject = async () => {
    const deadline = options.startedAt + FAULT_DELAY_SECONDS * 1000
    while (!stopped && performance.now() < deadline) await pause(deadline - performance.now())
    ensureRunning()
    if (plan.kind === 'storm') {
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

  return {
    stop,
    async finish() {
      if (failed) throw failure
      if (at === undefined) throw new Error('soak fault was not injected before the run ended')
      await injected
      ensureRunning()
      if (failed) throw failure
      const report = await call(options.control, 'report', {}) as PluginReport
      ensureRunning()
      return {
        kind: options.kind,
        check: FAULT_CHECK[options.kind],
        at: Number(at.toFixed(3)),
        detail: {
          pids: options.kind === 'leak' ? report.leaked : options.kind === 'zombies' ? report.holders : [],
          refreshes: report.refreshes,
          blockedMs: report.blockedMs
        }
      }
    }
  }
}

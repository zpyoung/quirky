import { ConnectionLost, type QuirkyClient } from '@quirky/protocol'
import { connectDaemon, readRuntime } from '@quirky/protocol/node'
import { DEFAULT_LIMITS, type EventRecord, type ProbeRecord } from './contracts'

export type Probe = {
  events: EventRecord[]
  probes: ProbeRecord[]
  daemonExited(): boolean
  /** Records a stalled in-flight attempt, then stops the probe. */
  finish(): void
  stop(): void
}

export type StartProbeOptions = {
  home: string
  startedAt: number
  onDaemonLost: () => void
  onPtyHostPid?: (pid: number | null) => void
  signal?: AbortSignal
  isDaemonDead?: () => boolean
  maxStallMs?: number
  connect?: (home: string) => Promise<QuirkyClient>
  connectTimeoutMs?: number
  probeTimeoutMs?: number
  retryDelayMs?: number
}

type ActiveAttempt = { kind: 'connect' | 'status'; beganAt: number; ownLagMs: number }

class ProbeTimeoutError extends Error {}


function secondsSince(startedAt: number, now: number): number {
  return Number(((now - startedAt) / 1000).toFixed(3))
}

function milliseconds(value: number): number {
  return Number(value.toFixed(3))
}

function closeClient(client: QuirkyClient | undefined): void {
  try {
    client?.close()
  } catch {
    return
  }
}

function isRuntimeDaemonDead(home: string): boolean {
  const runtime = readRuntime(home)
  if (runtime === null || typeof runtime.pid !== 'number' || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) {
    return true
  }
  try {
    process.kill(runtime.pid, 0)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ESRCH') return true
    if (code === 'EPERM') return false
    throw error
  }
}

function waitWithAbort<T>(
  task: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onLateValue?: (value: T) => void
): Promise<T> {
  const closeLateValue = (value: T) => {
    try {
      onLateValue?.(value)
    } catch {
      return
    }
  }
  if (signal.aborted) {
    if (onLateValue) void task.then(closeLateValue, () => undefined)
    return Promise.reject(new Error('soak probe was stopped'))
  }

  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const deadline = performance.now() + timeoutMs
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = () => {
    signal.removeEventListener('abort', onAbort)
    clearTimeout(timer)
  }
  const onAbort = () => {
    if (settled) return
    settled = true
    cleanup()
    reject(new Error('soak probe was stopped'))
  }
  const onTimeout = () => {
    if (settled) return
    const remaining = deadline - performance.now()
    if (remaining > 0) {
      timer = setTimeout(onTimeout, remaining)
      return
    }
    settled = true
    cleanup()
    reject(new ProbeTimeoutError(`soak probe timed out after ${timeoutMs} ms`))
  }

  signal.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(onTimeout, timeoutMs)
  task.then(
    (value) => {
      if (settled) {
        closeLateValue(value)
        return
      }
      settled = true
      cleanup()
      resolve(value)
    },
    (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
  )
  return promise
}


function pidFromStatus(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const ptyHost = (value as { ptyHost?: unknown }).ptyHost
  if (ptyHost === null || typeof ptyHost !== 'object' || Array.isArray(ptyHost)) return null
  const pid = (ptyHost as { pid?: unknown }).pid
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** Opens an independent subscribed client and continuously records daemon events and status probes. */
export function startProbe(options: StartProbeOptions): Probe {
  const events: EventRecord[] = []
  const probes: ProbeRecord[] = []
  const controller = new AbortController()
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000
  const probeTimeoutMs = options.probeTimeoutMs ?? 30_000
  const retryDelayMs = options.retryDelayMs ?? 250
  const maxStallMs = options.maxStallMs ?? DEFAULT_LIMITS.maxStallMs
  const connect = options.connect ?? ((home: string) => connectDaemon({
    home,
    role: 'cli',
    name: 'soak-probe',
    subscribe: true,
    autostart: false
  }))
  const isDaemonDead = options.isDaemonDead ?? (() => isRuntimeDaemonDead(options.home))

  let stopped = false
  let daemonExited = false
  let daemonLostNotified = false
  let activeClient: QuirkyClient | undefined
  let activeAttempt: ActiveAttempt | undefined
  let latenessTimer: ReturnType<typeof setInterval> | undefined
  let pauseTimer: ReturnType<typeof setTimeout> | undefined
  let wakePause: (() => void) | undefined
  let unsubscribeEvent: () => void = () => undefined
  let unsubscribeClose: () => void = () => undefined
  let nextTimerAt = performance.now() + 50

  const notifyDaemonLost = (exited: boolean) => {
    if (exited) daemonExited = true
    if (daemonLostNotified) return
    daemonLostNotified = true
    try {
      options.onDaemonLost()
    } catch {
      return
    }
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    controller.abort()
    clearInterval(latenessTimer)
    latenessTimer = undefined
    clearTimeout(pauseTimer)
    pauseTimer = undefined
    wakePause?.()
    wakePause = undefined
    options.signal?.removeEventListener('abort', stop)
    unsubscribeEvent()
    unsubscribeClose()
    unsubscribeEvent = () => undefined
    unsubscribeClose = () => undefined
    closeClient(activeClient)
    activeClient = undefined
  }

  const markDaemonLost = () => {
    if (stopped) return
    notifyDaemonLost(true)
    stop()
  }

  const stopAfterTimeout = () => {
    if (stopped) return
    notifyDaemonLost(false)
    stop()
  }

  const onConnectionClose = () => {
    if (!stopped) markDaemonLost()
  }

  const currentOwnLagMs = (attempt: ActiveAttempt, now: number): number => {
    return milliseconds(Math.max(attempt.ownLagMs, Math.max(0, now - nextTimerAt)))
  }

  const settleAttempt = (attempt: ActiveAttempt, settledAt: number): number => {
    const ownLagMs = currentOwnLagMs(attempt, settledAt)
    if (activeAttempt === attempt) activeAttempt = undefined
    return ownLagMs
  }

  const appendProbe = (beganAt: number, ms: number, ownLagMs: number, timedOut: boolean) => {
    probes.push({
      at: secondsSince(options.startedAt, beganAt),
      ms: milliseconds(ms),
      ownLagMs: milliseconds(ownLagMs),
      timedOut
    })
  }

  const pauseAfterSettle = (delayMs: number): Promise<void> => {
    if (stopped || delayMs <= 0) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    let done = false
    const finishPause = () => {
      if (done) return
      done = true
      controller.signal.removeEventListener('abort', finishPause)
      clearTimeout(pauseTimer)
      pauseTimer = undefined
      wakePause = undefined
      resolve()
    }
    wakePause = finishPause
    controller.signal.addEventListener('abort', finishPause, { once: true })
    pauseTimer = setTimeout(finishPause, delayMs)
    return promise
  }

  const finish = () => {
    if (stopped) return
    const attempt = activeAttempt
    if (attempt) {
      const now = performance.now()
      const timeoutMs = attempt.kind === 'connect' ? connectTimeoutMs : probeTimeoutMs
      const elapsedMs = Math.min(timeoutMs, milliseconds(now - attempt.beganAt))
      if (elapsedMs > maxStallMs) {
        appendProbe(
          attempt.beganAt,
          elapsedMs,
          currentOwnLagMs(attempt, now),
          attempt.kind === 'connect' || now - attempt.beganAt >= probeTimeoutMs
        )
      }
    }
    stop()
  }

  const probe: Probe = {
    events,
    probes,
    daemonExited: () => daemonExited,
    finish,
    stop
  }

  if (options.signal?.aborted) {
    stop()
    return probe
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) {
    stop()
    return probe
  }

  latenessTimer = setInterval(() => {
    const now = performance.now()
    const lateness = Math.max(0, now - nextTimerAt)
    nextTimerAt = now + 50
    if (activeAttempt && lateness > activeAttempt.ownLagMs) activeAttempt.ownLagMs = lateness
  }, 50)

  const runStatusLoop = async (client: QuirkyClient): Promise<void> => {
    while (!stopped && !daemonExited) {
      const beganAt = performance.now()
      const attempt: ActiveAttempt = { kind: 'status', beganAt, ownLagMs: 0 }
      activeAttempt = attempt
      let response: unknown
      let failed = false
      let failure: unknown
      try {
        response = await waitWithAbort(
          client.callAny('status.get', {}, { timeoutMs: probeTimeoutMs }),
          controller.signal,
          probeTimeoutMs
        )
      } catch (error) {
        failed = true
        failure = error
      }
      const settledAt = performance.now()
      const ownLagMs = settleAttempt(attempt, settledAt)
      if (stopped || daemonExited) return
      const elapsed = settledAt - beganAt

      if (failed) {
        if (failure instanceof ConnectionLost) {
          markDaemonLost()
          return
        }
        const rpcTimedOut = failure instanceof Error
          && failure.message === `RPC call timed out after ${probeTimeoutMs} ms`
        if (failure instanceof ProbeTimeoutError || elapsed >= probeTimeoutMs || rpcTimedOut) {
          appendProbe(beganAt, probeTimeoutMs, ownLagMs, true)
          stopAfterTimeout()
          return
        }
        appendProbe(beganAt, elapsed, ownLagMs, false)
      } else {
        if (elapsed >= probeTimeoutMs) {
          appendProbe(beganAt, probeTimeoutMs, ownLagMs, true)
          stopAfterTimeout()
          return
        }
        options.onPtyHostPid?.(pidFromStatus(response))
        appendProbe(beganAt, elapsed, ownLagMs, false)
      }

      if (stopped || daemonExited) return
      await pauseAfterSettle(Math.max(0, 250 - (performance.now() - settledAt)))
    }
  }

  const run = async (): Promise<void> => {
    while (!stopped && !daemonExited) {
      if (isDaemonDead()) {
        markDaemonLost()
        return
      }

      const beganAt = performance.now()
      const attempt: ActiveAttempt = { kind: 'connect', beganAt, ownLagMs: 0 }
      activeAttempt = attempt
      let client: QuirkyClient | undefined
      let failed = false
      let failure: unknown
      try {
        client = await waitWithAbort(
          connect(options.home),
          controller.signal,
          connectTimeoutMs,
          closeClient
        )
      } catch (error) {
        failed = true
        failure = error
      }
      const settledAt = performance.now()
      const ownLagMs = settleAttempt(attempt, settledAt)
      if (stopped || daemonExited) {
        closeClient(client)
        return
      }
      const elapsed = settledAt - beganAt

      if (failed) {
        if (failure instanceof ConnectionLost || isDaemonDead()) {
          markDaemonLost()
          return
        }
        if (failure instanceof ProbeTimeoutError || elapsed >= connectTimeoutMs) {
          appendProbe(beganAt, connectTimeoutMs, ownLagMs, true)
          stopAfterTimeout()
          return
        }
        appendProbe(beganAt, elapsed, ownLagMs, true)
        await pauseAfterSettle(Math.max(0, retryDelayMs - (performance.now() - settledAt)))
        continue
      }

      if (elapsed >= connectTimeoutMs) {
        closeClient(client)
        appendProbe(beganAt, connectTimeoutMs, ownLagMs, true)
        stopAfterTimeout()
        return
      }
      if (!client) return
      activeClient = client
      unsubscribeClose = client.onClose(onConnectionClose)
      if (client.isClosed) {
        onConnectionClose()
        return
      }
      if (stopped) return
      unsubscribeEvent = client.onEvent((event) => {
        if (!stopped && !daemonExited) {
          events.push({ at: secondsSince(options.startedAt, performance.now()), type: event.type })
        }
      })
      if (client.isClosed) {
        onConnectionClose()
        return
      }
      await runStatusLoop(client)
      return
    }
  }

  void run().catch((error: unknown) => {
    stop()
    throw error
  })
  return probe
}

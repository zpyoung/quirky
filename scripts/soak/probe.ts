import { ConnectionLost, type QuirkyClient } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import type { EventRecord, ProbeRecord } from './contracts'

export type Probe = {
  events: EventRecord[]
  probes: ProbeRecord[]
  daemonExited(): boolean
  stop(): void
}

type StartProbeOptions = {
  home: string
  startedAt: number
  onDaemonLost: () => void
  onPtyHostPid?: (pid: number | null) => void
  signal?: AbortSignal
}

type ActiveProbe = { ownLagMs: number }

function secondsSince(startedAt: number, now: number): number {
  return Number(((now - startedAt) / 1000).toFixed(3))
}

function milliseconds(value: number): number {
  return Number(value.toFixed(3))
}

function aborted(): Error {
  return new Error('soak probe setup was interrupted')
}

function waitWithAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(aborted())
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const onAbort = () => {
    signal.removeEventListener('abort', onAbort)
    reject(aborted())
  }
  signal.addEventListener('abort', onAbort, { once: true })
  task.then(
    (value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    },
    (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
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
export async function startProbe(options: StartProbeOptions): Promise<Probe> {
  if (options.signal?.aborted) throw aborted()
  const connecting = connectDaemon({ home: options.home, role: 'cli', name: 'soak-probe', subscribe: true, autostart: false })
  void connecting.then(
    (client) => {
      if (options.signal?.aborted) client.close()
    },
    () => undefined
  )

  let client: QuirkyClient | undefined
  try {
    client = await waitWithAbort(connecting, options.signal)
    if (options.signal?.aborted) throw aborted()
  } catch (error) {
    client?.close()
    throw error
  }

  const activeClient = client
  const events: EventRecord[] = []
  const probes: ProbeRecord[] = []
  let stopped = false
  let disconnected = false
  let stopRequested = false
  let activeProbe: ActiveProbe | undefined
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  let wakeDelay: (() => void) | undefined
  let unsubscribeEvent: () => void = () => undefined
  let unsubscribeClose: () => void = () => undefined
  let nextTimerAt = performance.now() + 50

  const requestStop = () => {
    if (stopped || stopRequested) return
    stopRequested = true
    try {
      options.onDaemonLost()
    } catch {
      return
    }
  }

  const stopSampling = () => {
    clearInterval(latenessTimer)
    activeProbe = undefined
    wakeDelay?.()
  }

  const onConnectionClose = () => {
    if (stopped || disconnected) return
    disconnected = true
    stopSampling()
    unsubscribeEvent()
    requestStop()
  }

  const latenessTimer = setInterval(() => {
    const now = performance.now()
    const lateness = Math.max(0, now - nextTimerAt)
    nextTimerAt = now + 50
    if (activeProbe && lateness > activeProbe.ownLagMs) activeProbe.ownLagMs = lateness
  }, 50)

  unsubscribeClose = activeClient.onClose(onConnectionClose)
  unsubscribeEvent = activeClient.onEvent((event) => {
    if (!stopped && !disconnected) events.push({ at: secondsSince(options.startedAt, performance.now()), type: event.type })
  })

  const pauseAfterSettle = (delayMs: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (delayTimer !== undefined) clearTimeout(delayTimer)
      delayTimer = undefined
      wakeDelay = undefined
      resolve()
    }
    wakeDelay = finish
    delayTimer = setTimeout(finish, delayMs)
    return promise
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    stopSampling()
    unsubscribeEvent()
    unsubscribeClose()
    options.signal?.removeEventListener('abort', stop)
    try {
      activeClient.close()
    } catch {
      return
    }
  }

  options.signal?.addEventListener('abort', stop, { once: true })

  const run = async () => {
    while (!stopped && !disconnected) {
      const beganAt = performance.now()
      let settledAt = beganAt
      const current: ActiveProbe = { ownLagMs: 0 }
      activeProbe = current
      try {
        const response = await activeClient.callAny('status.get', {}, { timeoutMs: 30_000 })
        settledAt = performance.now()
        const elapsed = settledAt - beganAt
        const settledLag = Math.max(0, settledAt - nextTimerAt)
        if (settledLag > current.ownLagMs) current.ownLagMs = settledLag
        activeProbe = undefined
        if (stopped || disconnected) return
        if (elapsed >= 30_000) {
          probes.push({
            at: secondsSince(options.startedAt, beganAt),
            ms: 30_000,
            ownLagMs: milliseconds(current.ownLagMs),
            timedOut: true
          })
          requestStop()
          stop()
          return
        }
        options.onPtyHostPid?.(pidFromStatus(response))
        probes.push({
          at: secondsSince(options.startedAt, beganAt),
          ms: milliseconds(elapsed),
          ownLagMs: milliseconds(current.ownLagMs),
          timedOut: false
        })
      } catch (error) {
        settledAt = performance.now()
        const settledLag = Math.max(0, settledAt - nextTimerAt)
        if (settledLag > current.ownLagMs) current.ownLagMs = settledLag
        activeProbe = undefined
        if (stopped || disconnected) return
        if (error instanceof ConnectionLost) {
          onConnectionClose()
          return
        }
        const elapsed = settledAt - beganAt
        const timedOut = elapsed >= 30_000 || error instanceof Error && error.message === 'RPC call timed out after 30000 ms'
        probes.push({
          at: secondsSince(options.startedAt, beganAt),
          ms: timedOut ? 30_000 : milliseconds(elapsed),
          ownLagMs: milliseconds(current.ownLagMs),
          timedOut
        })
        if (timedOut) {
          requestStop()
          stop()
          return
        }
      }

      if (stopped || disconnected) return
      await pauseAfterSettle(Math.max(0, 250 - (performance.now() - settledAt)))
    }
  }

  if (!disconnected) void run().catch(() => requestStop())
  return {
    events,
    probes,
    daemonExited: () => disconnected,
    stop
  }
}

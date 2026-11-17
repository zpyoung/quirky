import { ConnectionLost, type QuirkyClient } from '@quirky/protocol'
import { connectDaemon, readRuntime } from '@quirky/protocol/node'
import {
  DEFAULT_LIMITS,
  type EventRecord,
  type GitProbeRecord,
  type ProbeRecord,
  type TerminalProbeRecord
} from './contracts'

export type Probe = {
  events: EventRecord[]
  probes: ProbeRecord[]
  gitProbes: GitProbeRecord[]
  terminalProbes: TerminalProbeRecord[]
  daemonExited(): boolean
  /** Records stalled in-flight attempts, then stops the probe. */
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
  gitProbe?: { worktrees: readonly string[]; intervalMs?: number }
  terminalProbe?: { session: string; intervalMs?: number }
}

type ActiveClockAttempt = { beganAt: number; ownLagMs: number }
type ActiveAttempt = ActiveClockAttempt & { kind: 'connect' | 'status' }
type ActiveGitAttempt = ActiveClockAttempt & { worktree: string }
type ActiveTerminalAttempt = ActiveClockAttempt & {
  streamId?: number
  resolvePong?: () => void
  rejectPong?: (error: unknown) => void
}

class ProbeTimeoutError extends Error {}
class TerminalLagError extends Error {}

function secondsSince(startedAt: number, now: number): number {
  return Number(((now - startedAt) / 1000).toFixed(3))
}

function milliseconds(value: number): number {
  return Number(value.toFixed(3))
}

/** Feeds decoded output and reports whether a complete line equals the expected pong. */
export function createPongMatcher(): { expect(token: string | null): void; push(bytes: Uint8Array): boolean } {
  const decoder = new TextDecoder()
  let expected: string | null = null
  let tail = ''
  let dropping = false

  return {
    expect(token) {
      expected = token === null ? null : `soak-pong ${token}`
    },
    push(bytes) {
      const text = decoder.decode(bytes, { stream: true })
      let matched = false
      let offset = 0

      while (offset <= text.length) {
        const newline = text.indexOf('\n', offset)
        if (newline < 0) {
          if (!dropping) {
            if (tail.length + text.length - offset > 64) {
              tail = ''
              dropping = true
            } else {
              tail += text.slice(offset)
            }
          }
          break
        }

        if (dropping) {
          dropping = false
        } else if (tail.length + newline - offset <= 64) {
          let line = tail + text.slice(offset, newline)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line === expected) matched = true
        }
        tail = ''
        offset = newline + 1
      }
      return matched
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function terminalSessionSize(
  value: unknown,
  sessionId: string
): { cols: number; rows: number } | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null
  for (const session of value.sessions) {
    if (!isRecord(session) || session.sessionId !== sessionId) continue
    const { cols, rows } = session
    if (
      typeof cols === 'number' && Number.isSafeInteger(cols) && cols > 0
      && typeof rows === 'number' && Number.isSafeInteger(rows) && rows > 0
    ) {
      return { cols, rows }
    }
    return null
  }
  return null
}

function terminalStreamId(value: unknown): number | null {
  if (!isRecord(value)) return null
  const streamId = value.streamId
  return typeof streamId === 'number' && Number.isSafeInteger(streamId) && streamId > 0
    ? streamId
    : null
}

function isRpcTimeout(error: unknown): boolean {
  return error instanceof Error && /^RPC call timed out after \d+ ms$/.test(error.message)
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
  const gitProbes: GitProbeRecord[] = []
  const terminalProbes: TerminalProbeRecord[] = []
  const controller = new AbortController()
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000
  const probeTimeoutMs = options.probeTimeoutMs ?? 30_000
  const retryDelayMs = options.retryDelayMs ?? 250
  const maxStallMs = options.maxStallMs ?? DEFAULT_LIMITS.maxStallMs
  const gitProbeIntervalMs = options.gitProbe?.intervalMs ?? 1_000
  const terminalIntervalMs = options.terminalProbe?.intervalMs ?? 1_000
  const terminalMatcher = options.terminalProbe ? createPongMatcher() : undefined
  const terminalNonce = options.terminalProbe
    ? Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    : undefined
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
  let activeGitAttempt: ActiveGitAttempt | undefined
  let activeTerminalAttempt: ActiveTerminalAttempt | undefined
  let activeTerminalStreamId: number | undefined
  let unsubscribeTerminalOutput: (() => void) | undefined
  let latenessTimer: ReturnType<typeof setInterval> | undefined
  let pauseTimer: ReturnType<typeof setTimeout> | undefined
  let wakePause: (() => void) | undefined
  let unsubscribeEvent: () => void = () => undefined
  let unsubscribeClose: () => void = () => undefined
  let nextTimerAt = performance.now() + 50
  const detachTerminalStream = (client: QuirkyClient | undefined, streamId = activeTerminalStreamId): void => {
    if (streamId === undefined) return
    if (activeTerminalStreamId === streamId) {
      activeTerminalStreamId = undefined
      unsubscribeTerminalOutput?.()
      unsubscribeTerminalOutput = undefined
    }
    if (!client) return
    try {
      void client.callAny('quirky.terminal/detach', { streamId }).catch(() => undefined)
    } catch {
      return
    }
  }

  const appendTerminalProbe = (
    beganAt: number,
    ms: number,
    ownLagMs: number,
    timedOut: boolean,
    failed: boolean
  ): void => {
    terminalProbes.push({
      at: secondsSince(options.startedAt, beganAt),
      ms: milliseconds(ms),
      ownLagMs: milliseconds(ownLagMs),
      timedOut,
      failed
    })
  }

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
    activeTerminalAttempt?.rejectPong?.(new Error('soak probe was stopped'))
    activeTerminalAttempt = undefined
    terminalMatcher?.expect(null)
    detachTerminalStream(activeClient)
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

  const currentOwnLagMs = (attempt: ActiveClockAttempt, now: number): number => {
    return milliseconds(Math.max(attempt.ownLagMs, Math.max(0, now - nextTimerAt)))
  }

  const settleAttempt = (attempt: ActiveClockAttempt, settledAt: number): number => {
    const ownLagMs = currentOwnLagMs(attempt, settledAt)
    if (activeAttempt === attempt) activeAttempt = undefined
    if (activeGitAttempt === attempt) activeGitAttempt = undefined
    if (activeTerminalAttempt === attempt) activeTerminalAttempt = undefined
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

  const appendGitProbe = (
    beganAt: number,
    ms: number,
    ownLagMs: number,
    timedOut: boolean,
    failed: boolean,
    worktree: string
  ) => {
    gitProbes.push({
      at: secondsSince(options.startedAt, beganAt),
      ms: milliseconds(ms),
      ownLagMs: milliseconds(ownLagMs),
      timedOut,
      failed,
      worktree
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

  const pauseInterval = (delayMs: number): Promise<void> => {
    if (stopped || delayMs <= 0) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finishPause = () => {
      if (finished) return
      finished = true
      controller.signal.removeEventListener('abort', finishPause)
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(finishPause, delayMs)
    controller.signal.addEventListener('abort', finishPause, { once: true })
    if (controller.signal.aborted) finishPause()
    return promise
  }

  const finish = () => {
    if (stopped) return
    const now = performance.now()
    const attempt = activeAttempt
    if (attempt) {
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
    const gitAttempt = activeGitAttempt
    if (gitAttempt) {
      const ageMs = now - gitAttempt.beganAt
      const elapsedMs = Math.min(probeTimeoutMs, milliseconds(ageMs))
      if (ageMs > maxStallMs) {
        appendGitProbe(
          gitAttempt.beganAt,
          elapsedMs,
          currentOwnLagMs(gitAttempt, now),
          ageMs >= probeTimeoutMs,
          false,
          gitAttempt.worktree
        )
      }
    }
    const terminalAttempt = activeTerminalAttempt
    if (terminalAttempt) {
      const ageMs = now - terminalAttempt.beganAt
      const elapsedMs = Math.min(probeTimeoutMs, milliseconds(ageMs))
      if (ageMs > maxStallMs) {
        appendTerminalProbe(
          terminalAttempt.beganAt,
          elapsedMs,
          currentOwnLagMs(terminalAttempt, now),
          ageMs >= probeTimeoutMs,
          false
        )
      }
    }
    stop()
  }

  const probe: Probe = {
    events,
    probes,
    gitProbes,
    terminalProbes,
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
    if (activeGitAttempt && lateness > activeGitAttempt.ownLagMs) activeGitAttempt.ownLagMs = lateness
    if (activeTerminalAttempt && lateness > activeTerminalAttempt.ownLagMs) activeTerminalAttempt.ownLagMs = lateness
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

  const runGitLoop = async (client: QuirkyClient): Promise<void> => {
    const worktrees = options.gitProbe?.worktrees
    if (!worktrees?.length) return

    let worktreeIndex = 0
    while (!stopped && !daemonExited) {
      const worktree = worktrees[worktreeIndex]!
      const beganAt = performance.now()
      const attempt: ActiveGitAttempt = { beganAt, ownLagMs: 0, worktree }
      activeGitAttempt = attempt
      let failed = false
      let failure: unknown
      try {
        await waitWithAbort(
          client.callAny(
            'quirky.git/status',
            { worktree: `id:${worktree}` },
            { timeoutMs: probeTimeoutMs }
          ),
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
      const elapsedMs = settledAt - beganAt

      if (failed) {
        if (failure instanceof ConnectionLost) {
          markDaemonLost()
          return
        }
        const rpcTimedOut = failure instanceof Error
          && failure.message === `RPC call timed out after ${probeTimeoutMs} ms`
        if (failure instanceof ProbeTimeoutError || elapsedMs >= probeTimeoutMs || rpcTimedOut) {
          appendGitProbe(beganAt, probeTimeoutMs, ownLagMs, true, false, worktree)
        } else {
          appendGitProbe(beganAt, elapsedMs, ownLagMs, false, true, worktree)
        }
      } else if (elapsedMs >= probeTimeoutMs) {
        appendGitProbe(beganAt, probeTimeoutMs, ownLagMs, true, false, worktree)
      } else {
        appendGitProbe(beganAt, elapsedMs, ownLagMs, false, false, worktree)
      }

      worktreeIndex = (worktreeIndex + 1) % worktrees.length
      await pauseInterval(Math.max(0, beganAt + gitProbeIntervalMs - performance.now()))
    }
  }
  const runTerminalLoop = async (client: QuirkyClient): Promise<void> => {
    const terminalProbe = options.terminalProbe
    const matcher = terminalMatcher
    const nonce = terminalNonce
    if (!terminalProbe || !matcher || !nonce) return

    let sequence = 0
    const remainingMs = (beganAt: number): number => {
      return Math.max(0, probeTimeoutMs - (performance.now() - beganAt))
    }
    const terminalCall = (
      method: string,
      params: Record<string, unknown>,
      beganAt: number,
      onLateValue?: (value: unknown) => void
    ): Promise<unknown> => {
      const timeoutMs = remainingMs(beganAt)
      return waitWithAbort(
        client.callAny(method, params, { timeoutMs }),
        controller.signal,
        timeoutMs,
        onLateValue
      )
    }
    const detachLateAttach = (value: unknown): void => {
      const streamId = terminalStreamId(value)
      if (streamId !== null) detachTerminalStream(client, streamId)
    }
    const attachIfNeeded = async (attempt: ActiveTerminalAttempt): Promise<void> => {
      if (activeTerminalStreamId !== undefined) {
        attempt.streamId = activeTerminalStreamId
        return
      }

      const sessions = await terminalCall('quirky.terminal/sessions', {}, attempt.beganAt)
      const size = terminalSessionSize(sessions, terminalProbe.session)
      if (!size) throw new Error(`terminal session is unavailable: ${terminalProbe.session}`)

      const attached = await terminalCall('quirky.terminal/attach', {
        session: terminalProbe.session,
        cols: size.cols,
        rows: size.rows,
        historyLines: 0
      }, attempt.beganAt, detachLateAttach)
      if (stopped || daemonExited) {
        detachLateAttach(attached)
        return
      }

      const streamId = terminalStreamId(attached)
      if (streamId === null) throw new Error('terminal attach returned no stream id')
      activeTerminalStreamId = streamId
      attempt.streamId = streamId
      try {
        const unsubscribe = client.onTerminalOutput(
          streamId,
          (bytes) => {
            if (stopped || daemonExited || activeTerminalStreamId !== streamId) return
            if (matcher.push(bytes)) {
              const active = activeTerminalAttempt
              if (active?.streamId === streamId) active.resolvePong?.()
            }
          },
          {
            onLagged: () => {
              if (stopped || activeTerminalStreamId !== streamId) return
              const active = activeTerminalAttempt
              detachTerminalStream(client, streamId)
              if (active?.streamId === streamId) active.rejectPong?.(new TerminalLagError())
            }
          }
        )
        if (activeTerminalStreamId === streamId) unsubscribeTerminalOutput = unsubscribe
        else unsubscribe()
      } catch (error) {
        detachTerminalStream(client, streamId)
        throw error
      }
    }

    while (!stopped && !daemonExited) {
      const beganAt = performance.now()
      const token = `${nonce}-${++sequence}`
      const { promise: pong, resolve: resolvePong, reject: rejectPong } = Promise.withResolvers<void>()
      void pong.catch(() => undefined)
      const attempt: ActiveTerminalAttempt = {
        beganAt,
        ownLagMs: 0,
        resolvePong,
        rejectPong
      }
      activeTerminalAttempt = attempt
      matcher.expect(null)

      let failed = false
      let failure: unknown
      try {
        await attachIfNeeded(attempt)
        if (stopped || daemonExited) return

        matcher.expect(token)
        const send = terminalCall('quirky.terminal/send', {
          session: terminalProbe.session,
          text: `soak-ping ${token}\n`
        }, beganAt)
        await waitWithAbort(
          Promise.all([send, pong]),
          controller.signal,
          remainingMs(beganAt)
        )
      } catch (error) {
        failed = true
        failure = error
      }

      const settledAt = performance.now()
      if (stopped || daemonExited) {
        if (activeTerminalAttempt === attempt) activeTerminalAttempt = undefined
        matcher.expect(null)
        return
      }

      if (failed) attempt.rejectPong?.(failure)
      const ownLagMs = currentOwnLagMs(attempt, settledAt)
      if (activeTerminalAttempt === attempt) activeTerminalAttempt = undefined
      matcher.expect(null)
      if (failure instanceof ConnectionLost) {
        markDaemonLost()
        return
      }

      const elapsedMs = settledAt - beganAt
      const timedOut = (failed && (failure instanceof ProbeTimeoutError || isRpcTimeout(failure)))
        || elapsedMs >= probeTimeoutMs
      const recordFailed = failed && !timedOut
      appendTerminalProbe(
        beganAt,
        timedOut ? probeTimeoutMs : elapsedMs,
        ownLagMs,
        timedOut,
        recordFailed
      )
      if (timedOut || failure instanceof TerminalLagError) detachTerminalStream(client)

      await pauseInterval(Math.max(0, beganAt + terminalIntervalMs - performance.now()))
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
      const loops = [runStatusLoop(client)]
      if (options.gitProbe?.worktrees.length) loops.push(runGitLoop(client))
      if (options.terminalProbe) loops.push(runTerminalLoop(client))
      await Promise.all(loops)
      return
    }
  }

  void run().catch((error: unknown) => {
    stop()
    throw error
  })
  return probe
}

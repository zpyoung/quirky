import type { PluginPty } from '@quirky/protocol'
import { encodeBracketedPaste, submitDelayMs } from './core/paste'
import { createReadyScanner } from './core/ready'
import type { AgentEntry, DeliveryOutcome } from './core/types'

/** How long a liveness check may go unanswered before the delivery gives up on it. */
const LIVENESS_TIMEOUT_MS = 2000

const RECOVERY_RETRY_MS = 500
const MAX_EARLY_OUTPUT_BYTES = 4_194_304

/** Per-delivery switches. */
export type DeliverOptions = {
  /** The agent already shows its input: skip the ready wait and paste once the session is known alive. */
  ready?: boolean
}

type DeliveryRunnerOptions = {
  pty: PluginPty
  /** Registers a listener for sessions that were closed or forgotten; returns its remover. */
  onSessionGone: (listener: (sessionId: string) => void) => () => void
  /** Multiplies every timer, so tests need not wait out real delays. Defaults to 1. */
  timeScale?: number
  log?: (message: string) => void
  now?: () => number
}

/**
 * Pastes a prompt into an agent's input once the agent shows it can take one, and settles with how
 * far it got. Each delivery writes at most one paste, never retries it, and writes nothing once
 * settled.
 */
export class DeliveryRunner {
  private readonly pty: PluginPty
  private readonly onSessionGone: DeliveryRunnerOptions['onSessionGone']
  private readonly timeScale: number
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(options: DeliveryRunnerOptions) {
    this.pty = options.pty
    this.onSessionGone = options.onSessionGone
    this.timeScale = options.timeScale ?? 1
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  /**
   * Delivers `text` to the session's agent: `pasted` once ready, `unconfirmed` when the agent never
   * signalled and the entry allows a blind paste, `not-delivered` when the session ended first or
   * nothing could be written. With `submit` false the text is left in the input as a draft.
   *
   * The readiness deadline runs from the call and stays armed until the delivery settles, and a
   * liveness check gets its own short timeout, so a stalled PTY host cannot leave this pending.
   * Nothing is written to a session that is no longer alive.
   *
   * With `options.ready` the readiness wait is skipped entirely: the paste follows a liveness check
   * and settles `pasted`, or `not-delivered` when the session is gone or the write fails.
   */
  deliver(sessionId: string, entry: AgentEntry, text: string, submit: boolean, options: DeliverOptions = {}): Promise<DeliveryOutcome> {
    return new Promise((resolve) => {
      // scanner and deadline run on scaled time, so one factor converts to real timer delays
      const clock = () => this.now() / this.timeScale
      const startedAt = clock()
      const deadline = startedAt + entry.readyTimeoutMs
      const signal = submit ? entry.submitSignal : entry.readySignal
      let scanner = createReadyScanner(signal)

      let settled = false
      let subscribed = false
      let subscribing = options.ready !== true
      let acceptingOutput = options.ready !== true
      let pasting = false
      let pasteCommitted = false
      let pasteWritten = false
      let deadlineHandled = false
      let pasteOutcome: DeliveryOutcome = 'pasted'
      let timer: ReturnType<typeof setTimeout> | null = null
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null
      let livenessTimer: ReturnType<typeof setTimeout> | null = null
      let recoveryTimer: ReturnType<typeof setTimeout> | null = null
      let retryDue = false
      let gapObserved = false
      let earlyBytes = 0
      let pasteGeneration = 0
      let subscriptionGeneration = 0
      let subscribeInFlight: { generation: number; invalidatedByGap: boolean } | null = null
      const early: Uint8Array[] = []
      const removers: Array<() => void> = []

      const clearLivenessTimer = () => {
        if (livenessTimer !== null) {
          clearTimeout(livenessTimer)
          livenessTimer = null
        }
      }

      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        clearLivenessTimer()
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }
        if (recoveryTimer !== null) {
          clearTimeout(recoveryTimer)
          recoveryTimer = null
        }
      }

      const settle = (outcome: DeliveryOutcome) => {
        if (settled) {
          return
        }
        settled = true
        clearTimer()
        acceptingOutput = false
        early.length = 0
        earlyBytes = 0
        for (const remove of removers) {
          remove()
        }
        if (subscribed) {
          this.pty.unsubscribe(sessionId).catch(() => {})
        }
        if (outcome !== 'pasted') {
          this.log(`prompt for session ${sessionId} (${entry.id}) ${outcome}`)
        }
        resolve(outcome)
      }

      const after = (virtualMs: number, then: () => void) => {
        if (timer !== null) {
          clearTimeout(timer)
        }
        timer = setTimeout(() => {
          timer = null
          then()
        }, Math.max(0, virtualMs * this.timeScale))
      }

      const write = (data: string): boolean => {
        try {
          this.pty.write(sessionId, data)
          return true
        } catch {
          return false
        }
      }

      const sendEnter = (retry: boolean) => {
        if (settled) {
          return
        }
        if (!write('\r')) {
          settle(pasteOutcome)
          return
        }
        if (retry && entry.submitRetryMs !== null) {
          after(entry.submitRetryMs, () => sendEnter(false))
        } else {
          settle(pasteOutcome)
        }
      }

      const writePaste = (outcome: DeliveryOutcome) => {
        const enterNow = submit && entry.enterWithPaste
        if (!write(encodeBracketedPaste(text) + (enterNow ? '\r' : ''))) {
          settle('not-delivered')
          return
        }
        pasteWritten = true
        pasteOutcome = outcome
        if (!submit) {
          settle(outcome)
        } else if (enterNow) {
          if (entry.submitRetryMs !== null) {
            after(entry.submitRetryMs, () => sendEnter(false))
          } else {
            settle(outcome)
          }
        } else {
          after(submitDelayMs(text, entry), () => sendEnter(true))
        }
      }

      // the exit may predate our subscribe, and its replay can still hold the ready signal
      const isAlive = async (): Promise<boolean> => {
        try {
          const sessions = await this.pty.list()
          return sessions.some((info) => info.sessionId === sessionId && info.alive)
        } catch {
          return false
        }
      }

      const paste = (outcome: DeliveryOutcome) => {
        pasting = true
        const generation = ++pasteGeneration
        livenessTimer = setTimeout(() => {
          livenessTimer = null
          settle('not-delivered')
        }, Math.max(0, LIVENESS_TIMEOUT_MS * this.timeScale))
        isAlive().then((alive) => {
          if (settled || generation !== pasteGeneration || !pasting) {
            return
          }
          clearLivenessTimer()
          pasting = false
          if (alive) {
            pasteCommitted = true
            writePaste(outcome)
          } else {
            settle('not-delivered')
          }
        })
      }

      const onDeadline = () => {
        if (settled || pasteWritten || deadlineHandled) {
          return
        }
        deadlineHandled = true
        if (!gapObserved && !pasting && !subscribing && entry.blindPaste) {
          paste('unconfirmed')
        } else {
          settle('not-delivered')
        }
      }

      const check = () => {
        if (settled || pasteCommitted || pasteWritten || pasting || subscribing) {
          return
        }
        const at = clock()
        if (at >= deadline) {
          onDeadline()
          return
        }
        if (scanner.isReady(at)) {
          paste('pasted')
          return
        }
        const next = scanner.nextCheckAt()
        if (next !== null) {
          after(Math.min(next, deadline) - at, check)
        }
      }

      let startSubscribe: () => void
      const maybeStartRetry = () => {
        if (settled || !retryDue || subscribeInFlight !== null) {
          return
        }
        if (clock() >= deadline) {
          onDeadline()
          return
        }
        retryDue = false
        startSubscribe()
      }

      startSubscribe = () => {
        if (settled || subscribeInFlight !== null) {
          return
        }
        if (gapObserved && clock() >= deadline) {
          onDeadline()
          return
        }
        subscribing = true
        acceptingOutput = true
        early.length = 0
        earlyBytes = 0
        const attempt = { generation: subscriptionGeneration, invalidatedByGap: false }
        subscribeInFlight = attempt
        this.pty.subscribe(sessionId).then(
          ({ replay }) => {
            if (subscribeInFlight === attempt) {
              subscribeInFlight = null
            }
            if (attempt.invalidatedByGap || attempt.generation !== subscriptionGeneration) {
              maybeStartRetry()
              return
            }
            if (settled) {
              this.pty.unsubscribe(sessionId).catch(() => {})
              return
            }
            subscribed = true
            subscribing = false
            acceptingOutput = true
            const at = clock()
            scanner.push(Buffer.from(replay, 'base64'), at)
            for (const bytes of early) {
              scanner.push(bytes, at)
            }
            early.length = 0
            earlyBytes = 0
            check()
          },
          () => {
            if (subscribeInFlight === attempt) {
              subscribeInFlight = null
            }
            if (attempt.invalidatedByGap || attempt.generation !== subscriptionGeneration) {
              maybeStartRetry()
              return
            }
            if (settled) {
              return
            }
            subscribing = false
            settle('not-delivered')
          }
        )
      }

      const recover = () => {
        if (settled || pasteCommitted || pasteWritten || options.ready === true) {
          return
        }
        gapObserved = true
        subscriptionGeneration++
        if (subscribeInFlight !== null) {
          subscribeInFlight.invalidatedByGap = true
        }
        subscribed = false
        subscribing = true
        acceptingOutput = false
        scanner = createReadyScanner(signal)
        early.length = 0
        earlyBytes = 0
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (pasting) {
          pasting = false
          pasteGeneration++
          clearLivenessTimer()
        }
        if (recoveryTimer === null && !retryDue) {
          recoveryTimer = setTimeout(() => {
            recoveryTimer = null
            retryDue = true
            maybeStartRetry()
          }, Math.max(0, RECOVERY_RETRY_MS * this.timeScale))
        }
      }

      const sessionEnded = () => {
        if (pasteWritten) {
          settle(pasteOutcome)
        } else {
          settle('not-delivered')
        }
      }

      removers.push(
        this.pty.onData((id, bytes) => {
          if (id !== sessionId || settled || pasteCommitted || pasteWritten || pasting || !acceptingOutput) {
            return
          }
          if (subscribing) {
            if (earlyBytes + bytes.byteLength > MAX_EARLY_OUTPUT_BYTES) {
              recover()
              return
            }
            early.push(bytes)
            earlyBytes += bytes.byteLength
            return
          }
          scanner.push(bytes, clock())
          check()
        }),
        this.pty.onLagged((id) => {
          if (id === sessionId) {
            recover()
          }
        }),
        this.pty.onExit((id) => {
          if (id === sessionId) {
            sessionEnded()
          }
        }),
        this.pty.onReconnect(() => {
          if (!pasteWritten) {
            sessionEnded()
          }
        }),
        this.onSessionGone((id) => {
          if (id === sessionId) {
            sessionEnded()
          }
        })
      )

      if (options.ready === true) {
        paste('pasted')
        return
      }

      deadlineTimer = setTimeout(() => {
        deadlineTimer = null
        onDeadline()
      }, Math.max(0, entry.readyTimeoutMs * this.timeScale))
      startSubscribe()
    })
  }
}

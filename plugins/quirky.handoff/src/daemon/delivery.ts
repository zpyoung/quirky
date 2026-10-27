import type { PluginContext, PluginNotification, QuirkyEvent } from '@quirky/protocol'
import type { Call } from './source'
import type { Outcome } from './types'

/** How long to watch the child's agent status for evidence that a brief arrived. */
const WATCH_MS = 10_000

const RESEND_COMMAND = 'command:quirky.handoff/resend-confirm'
const DISCARD_COMMAND = 'command:quirky.handoff/discard'

type Paste = 'pasted' | 'unconfirmed' | 'not-delivered'

type StatusRow = { state?: unknown; turnStartedAt?: unknown; lastHookAt?: unknown }

type Retained = { agent: string; text: string; lineageId: string | null }

/** A live view of one child's agent status, kept from before the paste so no change is missed. */
type Observation = {
  /** Resolves once a turn began, the child closed, or the watch window ended. */
  settled: () => Promise<{ delivered: boolean; row: StatusRow | null }>
  stop: () => void
}

type Toast = Pick<PluginNotification, 'kind' | 'title' | 'detail' | 'persistent'>

const TOASTS: Record<Outcome, Toast> = {
  delivered: { kind: 'success', title: 'The handoff brief was sent.' },
  resent: { kind: 'warning', title: 'The initial delivery failed, then Quirky resent the brief.' },
  'retry-failed': { kind: 'error', title: 'Brief delivery and the automatic retry failed.', persistent: true },
  unobservable: {
    kind: 'warning',
    title: 'Brief delivery could not be confirmed.',
    detail: 'Resend is manual because the target Agent does not expose delivery evidence.',
    persistent: true
  }
}

/** The agents plugin's test scale, so tests need not wait out the real watch window. */
function watchMs(): number {
  const scale = Number(process.env.QUIRKY_TEST_AGENT_TIME_SCALE)
  return WATCH_MS * (Number.isFinite(scale) && scale > 0 ? scale : 1)
}

const turnedWorking = (row: StatusRow | null, since: number): boolean =>
  row !== null && row.state === 'working' && typeof row.turnStartedAt === 'number' && row.turnStartedAt >= since

const settledWithHooks = (row: StatusRow | null): boolean => row !== null && row.state === 'done' && typeof row.lastHookAt === 'number'

/**
 * Delivers a handoff brief to a child session and reports how far it got. Keeps each brief in
 * memory until it is delivered, discarded or its session is closed, so it can be resent.
 */
export class DeliveryTracker {
  private readonly retained = new Map<string, Retained>()
  private readonly running = new Map<string, Promise<Outcome>>()
  private readonly watchers = new Set<(event: QuirkyEvent) => void>()

  constructor(
    private readonly context: PluginContext,
    private readonly call: Call
  ) {}

  /** Keeps `text` for `child` so it can be resent. */
  retain(child: string, brief: Retained): void {
    this.retained.set(child, brief)
  }

  /** Records which lineage record the retained brief belongs to. */
  linkLineage(child: string, lineageId: string): void {
    const brief = this.retained.get(child)
    if (brief !== undefined) this.retained.set(child, { ...brief, lineageId })
  }

  hasBrief(child: string): boolean {
    return this.retained.has(child)
  }

  /** Drops the retained brief; true when there was one. */
  discard(child: string): boolean {
    return this.retained.delete(child)
  }

  /** Follows session closes and status changes that delivery waits on. */
  onEvent(event: QuirkyEvent): void {
    if (event.type === 'quirky.session/removed') {
      const sessionId = (event.data as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === 'string') this.retained.delete(sessionId)
    }
    for (const watcher of this.watchers) watcher(event)
  }

  /**
   * Delivers the brief retained for `child` once and settles with the outcome, which is also
   * emitted and shown as a toast. A paste that lands is `delivered`; otherwise the child's agent
   * status is watched for a turn that began after `launchedAt`. Only positive evidence of an idle
   * agent (the paste was refused and its hooks report it settled) earns one automatic resend.
   */
  deliver(child: string, launchedAt: number): Promise<Outcome> {
    const brief = this.retained.get(child)
    if (brief === undefined) return Promise.resolve('unobservable')
    return this.share(child, async () => {
      const outcome = await this.firstAttempt(child, brief, launchedAt)
      this.settle(child, brief.lineageId, outcome)
      return outcome
    })
  }

  /**
   * Sends the retained brief again, once per child at a time: callers arriving while one is
   * running share its outcome. Callers check `hasBrief` first.
   */
  resend(child: string): Promise<Outcome> {
    const brief = this.retained.get(child)
    if (brief === undefined) return Promise.resolve('unobservable')
    return this.share(child, async () => {
      const observation = this.observe(child, Date.now())
      let outcome: Outcome
      try {
        const paste = await this.paste(child, brief)
        if (paste === 'pasted' || (await observation.settled()).delivered) outcome = 'delivered'
        else outcome = paste === 'not-delivered' ? 'retry-failed' : 'unobservable'
      } finally {
        observation.stop()
      }
      this.settle(child, brief.lineageId, outcome)
      return outcome
    })
  }

  private share(child: string, work: () => Promise<Outcome>): Promise<Outcome> {
    const running = this.running.get(child)
    if (running !== undefined) return running
    const promise = work().finally(() => this.running.delete(child))
    this.running.set(child, promise)
    return promise
  }

  private async firstAttempt(child: string, brief: Retained, launchedAt: number): Promise<Outcome> {
    const observation = this.observe(child, launchedAt)
    let watched: { delivered: boolean; row: StatusRow | null }
    let first: Paste
    try {
      first = await this.paste(child, brief)
      if (first === 'pasted') return 'delivered'
      watched = await observation.settled()
    } finally {
      observation.stop()
    }
    if (watched.delivered) return 'delivered'
    // a brief discarded while the first delivery ran must not be sent by the retry
    if (this.retained.has(child) && first === 'not-delivered' && settledWithHooks(watched.row)) {
      return (await this.paste(child, brief)) === 'pasted' ? 'resent' : 'retry-failed'
    }
    return 'unobservable'
  }

  private async paste(child: string, brief: Retained): Promise<Paste> {
    try {
      const result = (await this.call('quirky.agents/deliver', { sessionId: child, agent: brief.agent, text: brief.text, submit: true })) as {
        delivery?: Paste
      }
      return result.delivery ?? 'not-delivered'
    } catch {
      return 'not-delivered'
    }
  }

  private async readRow(child: string): Promise<StatusRow | null> {
    try {
      return (await this.call('quirky.agent-status/get', { session: child })) as StatusRow | null
    } catch {
      return null
    }
  }

  /**
   * Starts following the child's status row at once and keeps every change since: once a turn has
   * been seen working after `since` it counts, even if it has finished by the time the paste returns. The first read never
   * overrides a newer change that arrived while it ran.
   */
  private observe(child: string, since: number): Observation {
    let row: StatusRow | null = null
    let started = false
    let closed = false
    let heard = false
    let wake: (() => void) | null = null
    const note = (next: StatusRow | null) => {
      row = next
      if (turnedWorking(next, since)) started = true
    }
    const watcher = (event: QuirkyEvent) => {
      const data = 'data' in event ? (event.data as { sessionId?: unknown; row?: StatusRow | null } | undefined) : undefined
      if (data?.sessionId !== child) return
      if (event.type === 'quirky.session/removed') closed = true
      else if (event.type === 'quirky.agent-status/changed') {
        heard = true
        note(data.row ?? null)
      } else return
      wake?.()
    }
    this.watchers.add(watcher)
    const read = this.readRow(child).then((initial) => {
      if (heard) {
        if (turnedWorking(initial, since)) started = true
      } else note(initial)
      wake?.()
    })
    return {
      settled: async () => {
        await read
        if (!started && !closed) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, watchMs())
            wake = () => {
              if (!started && !closed) return
              clearTimeout(timer)
              resolve()
            }
          })
        }
        wake = null
        return { delivered: started, row }
      },
      stop: () => {
        this.watchers.delete(watcher)
      }
    }
  }

  private notify(notification: PluginNotification): void {
    try {
      this.context.notify(notification)
    } catch {
      return
    }
  }

  private settle(child: string, lineageId: string | null, outcome: Outcome): void {
    const toast = TOASTS[outcome]
    const kept = this.retained.has(child)
    if (outcome === 'delivered' || outcome === 'resent') this.retained.delete(child)
    this.context.emit('delivery', { child, lineageId, outcome })
    if (toast.persistent && !kept) return
    this.notify({
      title: toast.title,
      body: '',
      desktop: false,
      kind: toast.kind,
      key: `handoff:${child}`,
      ...(toast.detail === undefined ? {} : { detail: toast.detail }),
      ...(toast.persistent
        ? {
            persistent: true,
            actions: [{ label: 'Resend brief', command: RESEND_COMMAND, args: { session: child }, keepOpen: true }],
            onDismiss: { command: DISCARD_COMMAND, args: { session: child } }
          }
        : {})
    })
  }
}

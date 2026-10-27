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
      const launchedAt = Date.now()
      const paste = await this.paste(child, brief)
      let outcome: Outcome
      if (paste === 'pasted' || (await this.watch(child, launchedAt)).delivered) outcome = 'delivered'
      else outcome = paste === 'not-delivered' ? 'retry-failed' : 'unobservable'
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
    const first = await this.paste(child, brief)
    if (first === 'pasted') return 'delivered'
    const watched = await this.watch(child, launchedAt)
    if (watched.delivered) return 'delivered'
    if (first === 'not-delivered' && settledWithHooks(watched.row)) {
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

  /** Watches the child's status row until it shows a turn after `since`, the child closes, or the window ends. */
  private async watch(child: string, since: number): Promise<{ delivered: boolean; row: StatusRow | null }> {
    let row = await this.readRow(child)
    if (turnedWorking(row, since)) return { delivered: true, row }
    return new Promise((resolve) => {
      const finish = (delivered: boolean) => {
        clearTimeout(timer)
        this.watchers.delete(watcher)
        resolve({ delivered, row })
      }
      const watcher = (event: QuirkyEvent) => {
        const data = 'data' in event ? (event.data as { sessionId?: unknown; row?: StatusRow | null } | undefined) : undefined
        if (data?.sessionId !== child) return
        if (event.type === 'quirky.session/removed') return finish(false)
        if (event.type !== 'quirky.agent-status/changed') return
        row = data.row ?? null
        if (turnedWorking(row, since)) finish(true)
      }
      const timer = setTimeout(() => finish(false), watchMs())
      this.watchers.add(watcher)
    })
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

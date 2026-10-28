import { randomUUID } from 'node:crypto'

export type MobileNotification = {
  id: string
  seq: number
  at: number
  title: string
  body: string
  worktreeId?: string
  sessionId?: string
  desktopAway: boolean | null
}
export type NotificationPoll = {
  after?: number
  epoch?: string
  waitMs?: number
  onlyWhenDesktopAway?: boolean
  suppressWorktree?: string
  subscriptionId?: string
}
export type NotificationPage = {
  epoch: string
  cursor: number
  notifications: MobileNotification[]
  reset: boolean
  truncated: boolean
  presenceAvailable: boolean
}

/** A process-local, bounded replay log; caller identity is supplied by authenticated admission. */
export class NotificationReplay {
  readonly epoch = randomUUID()
  private rows: MobileNotification[] = []
  private cursor = 0
  private pending = new Map<string, { subscriptionId?: string; wake(): void; reject(error: Error): void }>()
  private stopped = false
  private presenceAvailable = false

  append(input: Pick<MobileNotification, 'title' | 'body' | 'worktreeId' | 'sessionId'>, desktopAway: boolean | null): MobileNotification {
    if (this.stopped) throw new Error('notification subscription closed')
    const seq = ++this.cursor
    const row: MobileNotification = {
      id: `${this.epoch}:${seq}`, seq, at: Date.now(),
      title: input.title.slice(0, 80), body: input.body.slice(0, 180), desktopAway,
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {})
    }
    this.presenceAvailable = desktopAway !== null
    this.rows.push(row)
    if (this.rows.length > 256) this.rows.shift()
    for (const waiter of this.pending.values()) waiter.wake()
    return row
  }

  async poll(deviceId: string, input: NotificationPoll = {}, signal?: AbortSignal): Promise<NotificationPage> {
    if (this.stopped || signal?.aborted) throw new Error('notification subscription closed')
    if (this.pending.has(deviceId)) throw new Error('a notification poll is already pending for this device')
    if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) throw new Error('invalid notification cursor')
    if (input.waitMs !== undefined && (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 25000)) throw new Error('invalid notification wait')
    if (input.epoch !== undefined && (typeof input.epoch !== 'string' || input.epoch.length > 64)) throw new Error('invalid notification epoch')
    if (input.suppressWorktree !== undefined && (typeof input.suppressWorktree !== 'string' || input.suppressWorktree.length > 4096)) throw new Error('invalid notification workspace')
    if (input.subscriptionId !== undefined && (typeof input.subscriptionId !== 'string' || input.subscriptionId.length > 128)) throw new Error('invalid notification subscription')
    const reset = input.epoch !== undefined && input.epoch !== this.epoch
    const after = reset ? 0 : input.after ?? 0
    if (after > this.cursor) throw new Error('notification cursor is ahead of this host')
    const waitMs = input.waitMs ?? 25000
    if (after === this.cursor && waitMs > 0) {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      let timer: Timer | undefined
      const finish = (error?: Error): void => {
        if (!this.pending.delete(deviceId)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = (): void => finish(new Error('notification subscription closed'))
      this.pending.set(deviceId, { subscriptionId: input.subscriptionId, wake: () => finish(), reject: finish })
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(), waitMs)
      if (signal?.aborted) abort()
      await promise
    }
    const truncated = this.rows.length > 0 && after < this.rows[0]!.seq - 1
    const notifications = this.rows.filter(row => row.seq > after &&
      (!input.onlyWhenDesktopAway || row.desktopAway !== false) &&
      (!input.suppressWorktree || row.worktreeId !== input.suppressWorktree))
    return { epoch: this.epoch, cursor: this.cursor, notifications, reset, truncated, presenceAvailable: this.presenceAvailable }
  }

  cancel(deviceId: string, subscriptionId?: string): boolean {
    const waiter = this.pending.get(deviceId)
    if (!waiter || (subscriptionId !== undefined && waiter.subscriptionId !== subscriptionId)) return false
    waiter.reject(new Error('notification subscription closed'))
    return true
  }

  dispose(): void {
    this.stopped = true
    for (const waiter of this.pending.values()) waiter.reject(new Error('notification subscription closed'))
    this.pending.clear()
    this.rows = []
  }
}

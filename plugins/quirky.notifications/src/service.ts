import {
  RpcErrorCode,
  type Ask,
  type PluginContext,
  type PluginNotification,
  type QuirkyEvent,
  type Session,
  type UiState,
  type Worktree
} from '@quirky/protocol'
import { Cooldown } from './cooldown'
import { playSound } from './player'
import { SOUND_IDS, deliverySound, type SoundId } from './sounds'
import {
  agentBanner,
  agentLabelFallback,
  askBanner,
  bellBanner,
  cut,
  programBanner,
  testBanner,
  type Banner
} from './text'
import {
  NOT_VIEWING,
  FLOATING_OVERLAY_ID,
  WORKTREE_VIEW_ID,
  sessionViewed,
  viewingOf,
  worktreeOpenInFocusedWindow,
  worktreeViewed,
  type Viewing
} from './viewed'

export type Source = 'agent' | 'bell' | 'program' | 'ask' | 'test' | 'heimdall' | 'loop'
export type Reason = 'delivered' | 'disabled' | 'source-disabled' | 'suppressed-focus' | 'cooldown'
export type Result = Reason | 'superseded' | 'dropped'
export type UnreadReason = 'agent' | 'bell' | 'notification'

export type StatusResult = {
  badge: number
  label: string
  unreadWorktrees: { id: string; name: string }[]
  unreadSessions: { id: string; worktreeId: string; reason: UnreadReason }[]
  pendingAsks: number
  sound: { ok: true } | { ok: false; reason: string }
}

export type SettledData = {
  sessionId: string
  worktreeId: string
  agent: string
  state: 'done' | 'waiting' | 'blocked'
  outcome?: string | null
  interrupted?: boolean
  toolName?: string | null
  toolInput?: string | null
  lastAssistantMessage?: string | null
}
export type LoopNotificationData = {
  loopId: string
  name: string
  event: 'completed' | 'paused' | 'cap' | 'needs-you'
  reason?: string
  detail?: string
  sessionId?: string
  worktreeId: string
}

export type ServiceOptions = {
  /** How long a bell waits for an agent completion that would replace it. */
  bellHoldMs?: number
  /** How long a delivered banner silences its worktree. */
  cooldownMs?: number
  now?: () => number
  /** How long a call to another plugin may take before it is given up on. */
  lookupTimeoutMs?: number
}

export const BELL_HOLD_MS = 250
export const LOOKUP_TIMEOUT_MS = 2000
const PROGRAM_TEXT_MAX = 256
const OWN_WRITE_TTL_MS = 60_000
const SETTING_PREFIX = 'setting:quirky.notifications/'

type Marker = UnreadReason
type Pending = {
  source: Source
  sessionId: string | null
  worktreeId: string | null
  marker?: Marker
  occasion?: 'always' | 'unfocused' | 'invisible'
  hold?: BellHold
  open?: PluginNotification['open']
  key?: string
  banner(): Promise<Banner>
}

class LookupTimeout extends Error {}

type BellHold = { sessionId: string; superseded: boolean }

const SOURCE_SWITCH: Partial<Record<Source, string>> = {
  agent: 'agentTaskComplete',
  bell: 'terminalBell',
  program: 'terminalNotifications'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === RpcErrorCode.MethodNotFound || code === RpcErrorCode.NotFound
}

/** The dock badge text: empty at 0, the number up to 99, `99+` above. */
export function badgeLabel(count: number): string {
  return count <= 0 ? '' : count > 99 ? '99+' : String(count)
}

/**
 * The one place that decides attention and delivery. Producers report events; this records unread
 * markers first, then runs the gates, and only a delivered banner reaches `context.notify`.
 */
export class NotificationsService {
  private readonly cooldown: Cooldown
  private readonly now: () => number
  private readonly bellHoldMs: number
  private readonly lookupTimeoutMs: number
  private tail: Promise<void> = Promise.resolve()
  private syncQueued = false
  private lastStatus: string | null = null
  private readonly ownWrites = new Map<string, number[]>()
  private readonly holds = new Set<BellHold>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private stopped = false

  constructor(
    private readonly context: PluginContext,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.bellHoldMs = options.bellHoldMs ?? BELL_HOLD_MS
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS
    this.cooldown = new Cooldown({
      ...(options.cooldownMs === undefined ? {} : { windowMs: options.cooldownMs }),
      now: this.now
    })
  }

  /** Stops timers and ignores later events. */
  shutdown(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** Computes the first status so later changes can be told from it. */
  start(): void {
    this.requestSync()
  }

  onEvent(event: QuirkyEvent): void {
    if (this.stopped) return
    switch (event.type) {
      case 'quirky.heimdall/notification':
        this.fire(() => this.heimdallNotification(event.data))
        return
      case 'quirky.agent-status/settled':
      case 'quirky.structured/settled':
        this.supersedeBells((event.data as SettledData).sessionId)
        this.fire(() => this.agentSettled(event.data as SettledData))
        return
      case 'quirky.terminal/bell': {
        const hold = this.openHold((event.data as { sessionId: string }).sessionId)
        this.fire(() => this.bell(hold))
        return
      }
      case 'quirky.terminal/notification':
        this.fire(() => this.terminalNotification(event.data as TerminalNotification))
        return
      case 'quirky.loops/notification':
        this.fire(() => this.loopNotification(event.data as LoopNotificationData))
        return
      case 'quirky.ask/created':
        this.fire(() => this.askCreated(event.data as { ask: Ask }))
        this.requestSync()
        return
      case 'quirky.ask/surfaced':
        this.fire(() => this.askSurfaced((event.data as { ask: Ask }).ask))
        this.requestSync()
        return
      case 'quirky.ask/resolved':
      case 'plugin.changed':
      case 'ui.window.changed':
      case 'ui.state.changed':
      case 'quirky.session/changed':
      case 'quirky.session/removed':
        this.requestSync()
        return
      case 'ui.report.changed':
        if (event.slot === WORKTREE_VIEW_ID || event.slot === FLOATING_OVERLAY_ID) this.requestSync()
        return
      case 'setting.changed':
        if (event.id.startsWith(SETTING_PREFIX)) this.requestSync()
        return
      case 'quirky.worktree/changed':
        this.worktreeChanged(event.data as { worktreeId?: string; unread?: boolean })
        return
      default:
        return
    }
  }

  /** The current status, computed fresh. */
  async status(): Promise<StatusResult> {
    return this.computeStatus(await this.listWorktrees())
  }

  /** Sends a program notification; the result names the gate that stopped it. */
  async send(params: Record<string, unknown>): Promise<{ delivered: boolean; reason: Reason }> {
    const body = params.body
    if (typeof body !== 'string' || body.trim() === '') throw this.context.error('invalid-params', 'body must be a non-empty string')
    for (const name of ['title', 'session', 'worktree'] as const) {
      if (params[name] !== undefined && typeof params[name] !== 'string') {
        throw this.context.error('invalid-params', `${name} must be a string`)
      }
    }
    let sessionId: string | null = null
    let worktreeId: string | null = null
    if (typeof params.session === 'string') {
      const session = (await this.context.call('quirky.session/get', { session: params.session })) as Session
      sessionId = session.id
      worktreeId = session.worktreeId
    } else if (typeof params.worktree === 'string') {
      const worktree = (await this.context.call('quirky.worktree/resolve', { selector: params.worktree })) as Worktree
      worktreeId = worktree.id
    }
    const title = typeof params.title === 'string' && params.title.trim() !== '' ? cut(params.title, PROGRAM_TEXT_MAX) : null
    const text = cut(body, PROGRAM_TEXT_MAX)
    const result = await this.enqueue(() =>
      this.handle({
        source: 'program',
        sessionId,
        worktreeId,
        marker: 'notification',
        banner: async () => programBanner({ worktree: (await this.place(worktreeId)).worktree || null, title, body: text })
      })
    )
    return { delivered: result === 'delivered', reason: result as Reason }
  }

  /** Sends the test notification, which skips the focus check and the cooldown. */
  async test(): Promise<{ delivered: boolean; reason: Reason }> {
    const result = await this.enqueue(() =>
      this.handle({ source: 'test', sessionId: null, worktreeId: null, banner: async () => testBanner() })
    )
    return { delivered: result === 'delivered', reason: result as Reason }
  }

  /** Plays a sound now, through the shell when one is connected, else here. */
  async preview(params: Record<string, unknown>): Promise<{ played: boolean; reason?: string }> {
    const volume = params.volume === undefined ? this.numberSetting('volume') : params.volume
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw this.context.error('invalid-params', 'volume must be a number from 0 to 100')
    }
    if (params.path !== undefined && typeof params.path !== 'string') throw this.context.error('invalid-params', 'path must be a string')
    if (params.sound !== undefined && !SOUND_IDS.includes(params.sound as SoundId)) {
      throw this.context.error('invalid-params', `sound must be one of ${SOUND_IDS.join(', ')}`)
    }
    const path = params.path as string | undefined
    const sound = path === undefined ? ((params.sound as SoundId | undefined) ?? (this.context.getSetting('sound') as SoundId)) : 'custom'
    if (sound === 'system') return { played: false, reason: 'System Default has no preview' }
    const choice = await deliverySound({
      sound,
      customSoundPath: path ?? String(this.context.getSetting('customSoundPath') ?? ''),
      volume,
      pluginDir: this.context.dir,
      checkTimeoutMs: this.lookupTimeoutMs
    })
    if (!choice.sound || typeof choice.sound.file !== 'string') return { played: false, reason: choice.problem ?? 'no sound to play' }
    this.context.emit('sound', { file: choice.sound.file, volume })
    if (!(await this.hasDesktopClient())) playSound(choice.sound.file, volume, (message) => this.context.log(message))
    return { played: true }
  }

  private fire(task: () => Promise<unknown>): void {
    void this.enqueue(task).catch((error) => this.context.log(`event handling failed: ${errorText(error)}`))
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private requestSync(): void {
    if (this.syncQueued) return
    this.syncQueued = true
    this.fire(async () => {
      this.syncQueued = false
      await this.sync()
    })
  }

  /** A call to another plugin that gives up after the lookup timeout, so one silent handler cannot hold the queue. */
  private async bounded(method: string, params: Record<string, unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LookupTimeout(`${method} did not answer within ${this.lookupTimeoutMs}ms`)), this.lookupTimeoutMs)
    })
    try {
      return await Promise.race([this.context.call(method, params), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private async lookup<T>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    try {
      return (await this.bounded(method, params)) as T
    } catch (error) {
      if (!isMissing(error)) this.context.log(`${method} failed: ${errorText(error)}`)
      return undefined
    }
  }

  private numberSetting(name: string): number {
    const value = this.context.getSetting(name)
    return typeof value === 'number' ? value : 100
  }

  private flag(name: string): boolean {
    return this.context.getSetting(name) === true
  }

  private async viewing(): Promise<Viewing> {
    const state = await this.lookup<UiState>('ui.state')
    return state ? viewingOf(state) : NOT_VIEWING
  }

  private async hasDesktopClient(): Promise<boolean> {
    const status = await this.lookup<{ clients: { role: string }[] }>('status.get')
    return status?.clients.some((client) => client.role === 'desktop') ?? true
  }

  private async listWorktrees(): Promise<Worktree[]> {
    return (await this.lookup<Worktree[]>('quirky.worktree/list')) ?? []
  }

  private async listSessions(): Promise<Session[]> {
    return (await this.lookup<Session[]>('quirky.session/list')) ?? []
  }

  // markers

  private async setSessionUnread(sessionId: string, unread: Marker | null): Promise<void> {
    try {
      await this.bounded('quirky.session/setUnread', { session: sessionId, unread })
    } catch (error) {
      if (!isMissing(error)) this.context.log(`could not mark session ${sessionId}: ${errorText(error)}`)
    }
  }

  private ownKey(worktreeId: string, unread: boolean): string {
    return `${worktreeId}:${unread}`
  }

  /**
   * Records the write before sending it. A write that timed out may still land, so its entry stays
   * until its event arrives or the entry expires; only a write that failed outright is withdrawn.
   */
  private async setWorktreeUnread(worktreeId: string, unread: boolean): Promise<void> {
    const key = this.ownKey(worktreeId, unread)
    const expiresAt = this.now() + OWN_WRITE_TTL_MS
    this.ownWrites.set(key, [...(this.ownWrites.get(key) ?? []), expiresAt])
    try {
      await this.bounded('quirky.worktree/set', { worktree: `id:${worktreeId}`, unread })
    } catch (error) {
      if (!(error instanceof LookupTimeout)) this.withdrawOwn(key, expiresAt)
      if (!isMissing(error)) this.context.log(`could not mark worktree ${worktreeId}: ${errorText(error)}`)
    }
  }

  private withdrawOwn(key: string, expiresAt: number): void {
    const entries = this.ownWrites.get(key) ?? []
    const index = entries.indexOf(expiresAt)
    if (index !== -1) entries.splice(index, 1)
    if (entries.length === 0) this.ownWrites.delete(key)
  }

  private consumeOwn(worktreeId: string, unread: boolean): boolean {
    const key = this.ownKey(worktreeId, unread)
    const now = this.now()
    const live = (this.ownWrites.get(key) ?? []).filter((expiresAt) => expiresAt > now)
    const consumed = live.shift() !== undefined
    if (live.length === 0) this.ownWrites.delete(key)
    else this.ownWrites.set(key, live)
    return consumed
  }

  /** A `set` that asked for unread=false and was not ours is Mark Read: it clears the worktree's sessions too. */
  private worktreeChanged(data: { worktreeId?: string; unread?: boolean }): void {
    this.requestSync()
    if (typeof data.worktreeId !== 'string' || typeof data.unread !== 'boolean') return
    if (this.consumeOwn(data.worktreeId, data.unread) || data.unread) return
    const worktreeId = data.worktreeId
    this.fire(async () => {
      for (const session of await this.listSessions()) {
        if (session.worktreeId === worktreeId && session.unread) await this.setSessionUnread(session.id, null)
      }
    })
  }

  // viewing and status

  private async sync(): Promise<void> {
    const worktrees = await this.listWorktrees()
    await this.autoRead(worktrees)
    const status = await this.computeStatus(worktrees)
    const text = JSON.stringify(status)
    const previous = this.lastStatus
    this.lastStatus = text
    if (previous !== null && previous !== text) this.context.emit('changed', { badge: status.badge })
  }

  /** Clears the markers of what an attended window shows. */
  private async autoRead(worktrees: Worktree[]): Promise<void> {
    const viewing = await this.viewing()
    if (!viewing.attended) return
    if (viewing.visibleSessions.size > 0) {
      for (const session of await this.listSessions()) {
        if (session.unread && sessionViewed(viewing, session.id)) await this.setSessionUnread(session.id, null)
      }
    }
    if (viewing.shownWorktree === null) return
    const shown = worktrees.find((worktree) => worktree.id === viewing.shownWorktree)
    if (shown?.unread) {
      shown.unread = false
      await this.setWorktreeUnread(shown.id, false)
    }
  }

  private async computeStatus(worktrees: Worktree[]): Promise<StatusResult> {
    const unread = worktrees.filter((worktree) => worktree.unread && !worktree.removing)
    const sessions = (await this.listSessions()).filter((session) => session.unread)
    const pendingAsks = await this.pendingAskCount()
    const badge = unread.length + pendingAsks
    const choice = await deliverySound({
      sound: String(this.context.getSetting('sound')),
      customSoundPath: String(this.context.getSetting('customSoundPath') ?? ''),
      volume: this.numberSetting('volume'),
      pluginDir: this.context.dir,
      checkTimeoutMs: this.lookupTimeoutMs
    })
    return {
      badge,
      label: badgeLabel(badge),
      unreadWorktrees: unread.map((worktree) => ({ id: worktree.id, name: worktree.name })),
      unreadSessions: sessions.map((session) => ({
        id: session.id,
        worktreeId: session.worktreeId,
        reason: session.unread as UnreadReason
      })),
      pendingAsks,
      sound: choice.problem === undefined ? { ok: true } : { ok: false, reason: choice.problem }
    }
  }

  private async pendingAskCount(): Promise<number> {
    return (await this.lookup<Ask[]>('quirky.ask/list', { pendingOnly: true }))?.length ?? 0
  }

  // sources

  private async agentSettled(data: SettledData): Promise<void> {
    await this.handle({
      source: 'agent',
      sessionId: data.sessionId,
      worktreeId: data.worktreeId,
      marker: 'agent',
      banner: async () => {
        const [place, label] = await Promise.all([this.place(data.worktreeId), this.agentLabel(data.agent)])
        return agentBanner({
          state: data.state,
          outcome: data.outcome ?? null,
          interrupted: data.interrupted === true,
          repo: place.repo,
          worktree: place.worktree || 'workspace',
          agentLabel: label,
          lastAssistantMessage: data.lastAssistantMessage ?? null,
          toolName: data.toolName ?? null,
          toolInput: data.toolInput ?? null
        })
      }
    })
  }

  private async bell(hold: BellHold): Promise<void> {
    const { sessionId } = hold
    let held = false
    try {
      const session = await this.lookup<Session>('quirky.session/get', { session: sessionId })
      if (!session) return
      held =
        (await this.handle({
          source: 'bell',
          sessionId,
          worktreeId: session.worktreeId,
          marker: 'bell',
          hold,
          banner: async () => {
            const place = await this.place(session.worktreeId)
            return bellBanner({ repo: place.repo, worktree: place.worktree })
          }
        })) === 'held'
    } finally {
      if (!held) this.holds.delete(hold)
    }
  }

  private async terminalNotification(data: TerminalNotification): Promise<void> {
    const session = await this.lookup<Session>('quirky.session/get', { session: data.sessionId })
    if (!session) return
    await this.handle({
      source: 'program',
      sessionId: data.sessionId,
      worktreeId: session.worktreeId,
      marker: 'notification',
      occasion: data.occasion,
      banner: async () => {
        const place = await this.place(session.worktreeId)
        return programBanner({ worktree: place.worktree || null, title: data.title, body: data.body })
      }
    })
  }
  private async loopNotification(data: LoopNotificationData): Promise<void> {
    if (data.event === 'paused' && (data.reason === 'user' || data.reason === 'interrupted-by-restart')) return
    const title = data.event === 'completed'
      ? 'Loop completed'
      : data.event === 'needs-you'
        ? 'Loop needs you'
        : data.event === 'cap' || data.reason?.startsWith('cap-')
          ? 'Loop reached its cap'
          : 'Loop paused'
    const detail = [data.reason, data.detail].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(': ')
    const body = cut(`${cut(data.name, PROGRAM_TEXT_MAX)}${detail ? `: ${cut(detail, PROGRAM_TEXT_MAX)}` : ''}`, PROGRAM_TEXT_MAX)
    await this.handle({
      source: 'loop',
      sessionId: data.sessionId ?? null,
      worktreeId: data.worktreeId,
      marker: 'notification',
      key: `loop:${data.loopId}:${data.event}`,
      banner: async () => ({ title, body })
    })
  }


  private async askCreated(data: { ask: Ask }): Promise<void> {
    const { ask } = data
    if (ask.queued || ask.envelope.status !== 'pending') return
    // a deadline already past resolves the ask right after `created`, and an expired ask is never announced
    const pending = await this.lookup<Ask[]>('quirky.ask/list', { pendingOnly: true })
    if (pending && !pending.some((candidate) => candidate.id === ask.id)) return
    await this.askSurfaced(ask)
  }

  private async heimdallNotification(data: unknown): Promise<void> {
    if (!isRecord(data) || typeof data.watcherId !== 'string' || data.watcherId.length === 0) return
    if (data.kind !== 'approval-requested' && data.kind !== 'terminal') return
    if (data.kind === 'approval-requested' && typeof data.actionKind !== 'string') return
    if (data.kind === 'terminal' && (typeof data.state !== 'string' || typeof data.reason !== 'string')) return
    const worktreeId = typeof data.worktreeId === 'string' ? data.worktreeId : null
    const title = data.kind === 'approval-requested' ? 'Watcher approval requested' : 'Watcher reached a terminal state'
    const body = data.kind === 'approval-requested' ? `${data.actionKind} is waiting for approval` : `${data.state}: ${data.reason}`
    await this.handle({
      source: 'heimdall',
      sessionId: null,
      worktreeId,
      marker: 'notification',
      open: { view: 'view:quirky.heimdall/fleet', input: { watcherId: data.watcherId } },
      banner: async () => ({ title, body })
    })
  }

  private async askSurfaced(ask: Ask): Promise<void> {
    await this.handle({
      source: 'ask',
      sessionId: ask.sessionId,
      worktreeId: ask.worktreeId,
      banner: async () => askBanner({ title: ask.spec.title ?? null, firstQuestion: ask.spec.questions[0]?.question ?? '' })
    })
  }

  // deciding

  private async handle(pending: Pending): Promise<Result | 'held'> {
    const viewing = await this.viewing()
    if (pending.occasion === 'unfocused' && viewing.focused) return this.decide(pending, 'dropped')
    if (pending.occasion === 'invisible' && pending.sessionId !== null && sessionViewed(viewing, pending.sessionId)) {
      return this.decide(pending, 'dropped')
    }
    if (pending.marker) {
      await this.mark(pending, pending.marker, viewing)
      this.context.emit('attention', { source: pending.source, sessionId: pending.sessionId, worktreeId: pending.worktreeId })
    }
    if (pending.source === 'bell') {
      this.holdBell(pending)
      return 'held'
    }
    return this.deliver(pending, viewing)
  }

  private async mark(pending: Pending, marker: Marker, viewing: Viewing): Promise<void> {
    if (pending.sessionId !== null && !sessionViewed(viewing, pending.sessionId)) {
      await this.setSessionUnread(pending.sessionId, marker)
    }
    if (pending.worktreeId !== null && !worktreeViewed(viewing, pending.worktreeId)) {
      await this.setWorktreeUnread(pending.worktreeId, true)
    }
  }

  /** Starts watching for a completion of `sessionId` from the moment its bell arrives. */
  private openHold(sessionId: string): BellHold {
    const hold: BellHold = { sessionId, superseded: false }
    this.holds.add(hold)
    return hold
  }

  /** Runs when a completion is received, before any lookup, so a slow decision cannot miss a bell's hold. */
  private supersedeBells(sessionId: unknown): void {
    for (const hold of this.holds) if (hold.sessionId === sessionId) hold.superseded = true
  }

  /** A bell waits briefly so a completion that rang it can replace its banner. */
  private holdBell(pending: Pending): void {
    const hold = pending.hold!
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.holds.delete(hold)
      if (this.stopped) return
      const superseded = hold.superseded
      this.fire(async () => {
        if (superseded) this.decide(pending, 'superseded')
        else await this.deliver(pending, await this.viewing())
      })
    }, this.bellHoldMs)
    this.timers.add(timer)
  }

  private decide(pending: Pending, result: Result): Result {
    this.context.emit('decided', {
      source: pending.source,
      sessionId: pending.sessionId,
      worktreeId: pending.worktreeId,
      result
    })
    return result
  }

  private gate(pending: Pending, viewing: Viewing): Reason {
    if (!this.flag('enabled')) return 'disabled'
    const switchName = SOURCE_SWITCH[pending.source]
    if (switchName !== undefined && !this.flag(switchName)) return 'source-disabled'
    if (pending.source === 'test') return 'delivered'
    if (this.flag('suppressWhenFocused') && pending.worktreeId !== null && worktreeOpenInFocusedWindow(viewing, pending.worktreeId)) {
      return 'suppressed-focus'
    }
    if (this.cooldown.check(pending.worktreeId ?? 'global')) return 'cooldown'
    return 'delivered'
  }

  private async deliver(pending: Pending, viewing: Viewing): Promise<Result> {
    const gated = this.gate(pending, viewing)
    if (gated !== 'delivered') return this.decide(pending, gated)

    const banner = await pending.banner()
    const choice = await deliverySound({
      sound: String(this.context.getSetting('sound')),
      customSoundPath: String(this.context.getSetting('customSoundPath') ?? ''),
      volume: this.numberSetting('volume'),
      pluginDir: this.context.dir,
      checkTimeoutMs: this.lookupTimeoutMs
    })
    const sound = choice.sound
    const playHere = sound !== undefined && typeof sound.file === 'string' && !(await this.hasDesktopClient())
    // preparation can be slow, so the window is checked and reserved at the moment of delivery
    if (pending.source !== 'test') {
      const key = pending.worktreeId ?? 'global'
      if (this.cooldown.check(key)) return this.decide(pending, 'cooldown')
      this.cooldown.reserve(key)
    }
    this.context.notify({
      title: banner.title,
      body: banner.body,
      ...(pending.key === undefined ? {} : { key: pending.key }),
      ...(pending.sessionId !== null ? { sessionId: pending.sessionId } : {}),
      ...(pending.worktreeId !== null ? { worktreeId: pending.worktreeId } : {}),
      ...(pending.open !== undefined
        ? { open: pending.open }
        : pending.sessionId !== null && pending.worktreeId !== null
          ? { open: { view: WORKTREE_VIEW_ID, input: { worktree: pending.worktreeId, session: pending.sessionId } } }
          : {}),
      ...(sound !== undefined ? { sound } : {}),
      ...(pending.source === 'test' ? { toast: false } : {})
    })
    if (playHere) playSound(sound!.file!, sound!.volume, (message) => this.context.log(message))
    return this.decide(pending, 'delivered')
  }

  // text

  private async place(worktreeId: string | null): Promise<{ worktree: string; repo: string | null }> {
    if (worktreeId === null) return { worktree: '', repo: null }
    const worktree = await this.lookup<Worktree>('quirky.worktree/resolve', { selector: `id:${worktreeId}` })
    if (!worktree) return { worktree: '', repo: null }
    if (worktree.kind === 'folder' || worktree.repoId.startsWith('group:')) return { worktree: worktree.name, repo: null }
    const repo = await this.lookup<{ name: string; displayName?: string | null }>('quirky.repo/resolve', { selector: worktree.repoId })
    return { worktree: worktree.name, repo: repo ? (repo.displayName ?? repo.name) : null }
  }

  private async agentLabel(agent: string): Promise<string> {
    const info = await this.lookup<{ label?: unknown }>('quirky.agents/get', { agent })
    return typeof info?.label === 'string' && info.label !== '' ? info.label : agentLabelFallback(agent)
  }
}

type TerminalNotification = {
  sessionId: string
  title: string | null
  body: string
  occasion: 'always' | 'unfocused' | 'invisible'
}

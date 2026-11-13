import {
  base64ToBytes,
  RpcErrorCode,
  type ClientStream,
  type CallerConnection,
  type PluginCaller,
  type PluginContext,
  type PluginEvent,
  type PtyFact,
  type PtySessionInfo,
  type PtySubscription,
  type Session
} from '@quirky/protocol'
import { FLOATING_WORKSPACE } from './layout/types'
import { InputTracker } from './input-tracker'
import { MobileDriverService } from './mobile-driver'

const DEFAULT_ENTER_DELAY_MS = 300
const DEFAULT_READ_LINES = 50
const DEFAULT_KILL_POLL_MS = 100
const KILL_POLLS = 65
const MAX_TAP_BYTES = 4 * 1024 * 1024
const MOBILE_RECOVERY_COOLDOWN_MS = 2_000
const RESYNC_COOLDOWN_MS = 2_000

type Attachment = { connectionId: number; stream: ClientStream; sessionId: string; mobile: boolean; resyncing?: boolean }
type SessionTitleLookup = (sessionIds: readonly string[]) => Promise<ReadonlyMap<string, string>>
/** Output that arrived while a subscribe request was in flight, kept until its response says where the replay ends. */
type Tap = { chunks: Uint8Array[]; buffered: number; total: number; overflow: boolean }
type ResyncWaiter = {
  connectionId: number
  sessionId: string
  streamId: number
  cancel(error: Error): void
  closedError: Error
}

const encoder = new TextEncoder()
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function pushTap(tap: Tap, bytes: Uint8Array): void {
  tap.total += bytes.length
  if (tap.overflow) return
  if (tap.buffered + bytes.length > MAX_TAP_BYTES) {
    tap.chunks.length = 0
    tap.buffered = 0
    tap.overflow = true
    return
  }
  tap.chunks.push(bytes.slice())
  tap.buffered += bytes.length
}

/** The plugin event a PTY host fact is reported as; null for facts only other plugins consume. */
export function factEvent(sessionId: string, fact: PtyFact): { name: string; data: Record<string, unknown> } | null {
  switch (fact.kind) {
    case 'bell':
      return { name: 'bell', data: { sessionId } }
    case 'command-finished':
      return { name: 'commandFinished', data: { sessionId, exitCode: fact.exitCode } }
    case 'title':
      return { name: 'title', data: { sessionId, title: fact.title } }
    case 'cwd':
      return { name: 'cwd', data: { sessionId, cwd: fact.cwd } }
    case 'notification':
      return { name: 'notification', data: { sessionId, title: fact.title, body: fact.body, occasion: fact.occasion } }
    case 'prompt':
    case 'program-status':
    case 'agent-status':
      return null
  }
}

/** The last two path segments of `cwd`, e.g. `/tmp/w/api` is `w/api`. */
function workspaceLabel(cwd: string): string {
  return cwd.split('/').filter(Boolean).slice(-2).join('/')
}

/** The pause between `list` polls while waiting for killed sessions to end; tests shorten it through the environment. */
function killPollMs(): number {
  const override = Number(process.env.QUIRKY_TEST_KILL_POLL_MS)
  return process.env.QUIRKY_TEST_KILL_POLL_MS !== undefined && Number.isFinite(override) ? override : DEFAULT_KILL_POLL_MS
}

/** The paste-then-Enter delay; tests shorten it through the environment. */
function enterDelayMs(): number {
  const override = Number(process.env.QUIRKY_TEST_ENTER_DELAY_MS)
  return process.env.QUIRKY_TEST_ENTER_DELAY_MS !== undefined && Number.isFinite(override) ? override : DEFAULT_ENTER_DELAY_MS
}

/**
 * Terminal I/O for PTY sessions: input, screen reads and the output streams of attached clients.
 *
 * Each attached session is subscribed on the PTY host once per attach and unsubscribed after the
 * last stream goes. `received` tracks the PTY host's byte offset as this service has seen it, so
 * a new stream gets exactly the bytes after its replay and a reconnect replays exactly the gap.
 */
export class TerminalService {
  private readonly bySession = new Map<string, Set<Attachment>>()
  private readonly silent = new Map<string, Set<Attachment>>()
  private readonly byConnection = new Map<number, Map<number, Attachment>>()
  private readonly pendingBySession = new Map<string, Set<Attachment>>()
  private readonly received = new Map<string, number>()
  private readonly taps = new Map<string, Tap>()
  private readonly holds = new Map<string, Tap>()
  private readonly mobileHolds = new Map<string, Tap>()
  private readonly mobileRecoveryAt = new Map<string, number>()
  private readonly mobileRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly mobileRecoveryQueued = new Map<string, symbol>()
  private readonly mobileRecoveryPending = new Set<string>()
  private readonly resyncAt = new Map<string, number>()
  private readonly resyncWaiters = new Set<ResyncWaiter>()
  private readonly attaching = new Map<string, number>()
  private readonly attachQueue = new Map<string, Promise<unknown>>()
  private readonly forgotten = new Set<string>()
  private closed = false

  private readonly mobile: MobileDriverService

  constructor(
    private readonly context: PluginContext,
    private readonly tabTitlesForSessions: SessionTitleLookup,
    private readonly inputs: InputTracker = new InputTracker()
  ) {
    this.mobile = new MobileDriverService(context, (sessionId, work) => this.enqueue(sessionId, work))
  }

  attach = async (params: Record<string, unknown>, caller: PluginCaller) => {
    this.refuseWhenClosed()
    let session = await this.requireTerminal(params.session as string)
    const connection = caller.role === 'plugin' ? undefined : caller.connection
    if (!connection) throw this.context.error('invalid-params', 'quirky.terminal/attach needs a client connection')
    this.refuseWhenClosed()
    let restored = false
    if (session.status === 'exited' && session.restorable) {
      session = (await this.context.call('quirky.session/restore', { session: session.id })) as Session
      this.mobile.sessionRestored(session.id)
      restored = true
      this.refuseWhenClosed()
    }
    const ended = session.status === 'exited'
    const stream = connection.openStream()
    const attachment: Attachment = { connectionId: connection.id, stream, sessionId: session.id, mobile: caller.role === 'mobile' }
    const pending = this.pendingBySession.get(session.id) ?? new Set<Attachment>()
    pending.add(attachment)
    this.pendingBySession.set(session.id, pending)
    let open = true
    stream.onClose(() => {
      open = false
      this.untrackPending(attachment)
      this.drop(attachment)
    })
    try {
      const result = await this.enqueue(session.id, async () => {
        if (!open) throw this.context.error('conflict', 'terminal connection closed while attaching')
        if (!ended) await this.mobile.attach(session.id, params.cols as number, params.rows as number, caller, params.claim === true)
        return this.subscribe(attachment, {
          historyLines: params.historyLines as number | undefined,
          isOpen: () => open
        })
      })
      this.untrackPending(attachment)
      return { ...result, restored }
    } catch (error) {
      stream.close()
      throw error
    }
  }

  resync = async (params: Record<string, unknown>, caller: PluginCaller) => {
    this.refuseWhenClosed()
    const connection = caller.role === 'plugin' ? undefined : caller.connection
    if (!connection) throw this.context.error('invalid-params', 'quirky.terminal/resync needs a client connection')
    const streamId = params.streamId as number
    const existing = this.byConnection.get(connection.id)?.get(streamId)
    if (!existing) throw this.context.error('not-found', `no such stream: ${streamId}`)
    await this.requireTerminal(existing.sessionId)
    this.refuseWhenClosed()

    const key = `${connection.id}:${existing.sessionId}`
    const now = Date.now()
    const nextAllowedAt = this.resyncAt.get(key)
    if (nextAllowedAt === undefined || now >= nextAllowedAt) {
      this.resyncAt.set(key, now + RESYNC_COOLDOWN_MS)
    } else {
      this.resyncAt.set(key, nextAllowedAt + RESYNC_COOLDOWN_MS)
      await this.waitForResyncSlot(connection, existing.sessionId, streamId, nextAllowedAt - now)
    }
    this.refuseWhenClosed()
    if (this.byConnection.get(connection.id)?.get(streamId) !== existing) {
      throw this.context.error('not-found', `no such stream: ${streamId}`)
    }

    const stream = connection.openStream()
    const attachment: Attachment = {
      connectionId: connection.id,
      stream,
      sessionId: existing.sessionId,
      mobile: existing.mobile
    }
    const pending = this.pendingBySession.get(existing.sessionId) ?? new Set<Attachment>()
    pending.add(attachment)
    this.pendingBySession.set(existing.sessionId, pending)
    let open = true
    stream.onClose(() => {
      open = false
      this.untrackPending(attachment)
      this.drop(attachment)
    })
    try {
      const result = await this.enqueue(existing.sessionId, async () => {
        if (!open) throw this.context.error('conflict', 'terminal connection closed while resyncing')
        if (this.byConnection.get(connection.id)?.get(streamId) !== existing) {
          throw this.context.error('not-found', `no such stream: ${streamId}`)
        }
        return this.subscribe(attachment, {
          historyLines: params.historyLines as number | undefined,
          isOpen: () => open
        })
      })
      this.untrackPending(attachment)
      existing.resyncing = true
      existing.stream.close()
      return result
    } catch (error) {
      attachment.resyncing = true
      stream.close()
      throw error
    }
  }

  detach = (params: Record<string, unknown>, caller: PluginCaller): { ok: true } => {
    const connection = caller.role === 'plugin' ? undefined : caller.connection
    const streamId = params.streamId as number
    const attachment = connection && this.byConnection.get(connection.id)?.get(streamId)
    if (!attachment) throw this.context.error('not-found', `no such stream: ${streamId}`)
    attachment.stream.close()
    return { ok: true }
  }

  /** Claims real user input before bytes are sent; query replies and injected prompts do not call it. */
  userInput = async (params: Record<string, unknown>): Promise<{ ok: true }> => {
    const session = await this.requireWritable(params.session as string)
    const identity = await this.context.call('quirky.session/identity', { session: session.id }) as {
      sessionId: string
      live: boolean
      processIncarnation: string
    }
    if (!identity.live || identity.sessionId !== session.id || identity.processIncarnation !== params.expectedIncarnation) {
      throw this.context.error('conflict', 'terminal process changed before user input; reattach before typing')
    }
    this.context.pty.reportUserInput({ session: session.id, expectedIncarnation: identity.processIncarnation })
    return { ok: true }
  }

  /** Types raw input; the session then counts as touched for the layout's exit rule. */
  write = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireWritable(params.session as string)
    this.mobile.assertCanInput(session.id, caller)
    this.inputs.mark(session.id)
    this.input(session.id, encoder.encode(params.data as string))
    return { ok: true }
  }

  clear = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireWritable(params.session as string)
    this.mobile.assertCanInput(session.id, caller)
    await this.context.pty.clear(session.id)
    return { ok: true }
  }

  resize = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireTerminal(params.session as string)
    return this.enqueue(session.id, () =>
      this.mobile.resize(session.id, params.cols as number, params.rows as number, params, caller)
    )
  }

  displayMode = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireTerminal(params.session as string)
    const keys = Object.keys(params)
    if (params.mode === 'phone') {
      if (keys.length !== 4 || keys.some((key) => !['session', 'mode', 'cols', 'rows'].includes(key)) ||
        !Number.isSafeInteger(params.cols) || (params.cols as number) < 1 || (params.cols as number) > 1000 ||
        !Number.isSafeInteger(params.rows) || (params.rows as number) < 1 || (params.rows as number) > 500) {
        throw this.context.error('invalid-params', 'phone display mode requires a valid terminal viewport')
      }
    } else if (params.mode !== 'desktop' || keys.length !== 2 || keys.some((key) => key !== 'session' && key !== 'mode')) {
      throw this.context.error('invalid-params', 'desktop display mode accepts only a session and mode')
    }
    return this.enqueue(session.id, () => this.mobile.displayMode(
      session.id,
      params.mode as 'phone' | 'desktop',
      params.cols as number | undefined,
      params.rows as number | undefined,
      caller
    ))
  }

  /** Types `text` into a shell; pastes it into an agent, and presses Enter after a pause when asked. */
  send = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireWritable(this.sessionOf(params, caller))
    const text = params.text as string
    const enter = params.enter === true
    this.mobile.assertCanInput(session.id, caller)
    if (session.agent === 'shell') {
      this.input(session.id, encoder.encode(enter ? `${text}\r` : text))
      return { ok: true }
    }
    this.input(session.id, encoder.encode(`\x1b[200~${text}\x1b[201~`))
    if (enter) {
      await new Promise((resolve) => setTimeout(resolve, enterDelayMs()))
      this.mobile.assertCanInput(session.id, caller)
      this.input(session.id, encoder.encode('\r'))
    }
    return { ok: true }
  }

  read = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const session = await this.requireTerminal(this.sessionOf(params, caller))
    return this.context.pty.read(session.id, (params.lines as number | undefined) ?? DEFAULT_READ_LINES)
  }

  snapshot = async (params: Record<string, unknown>) => {
    const session = await this.requireTerminal(this.sessionOf(params, undefined))
    return this.context.pty.snapshot(session.id)
  }

  history = async (params: Record<string, unknown>) => {
    const session = await this.requireTerminal(this.sessionOf(params, undefined))
    return this.context.pty.history(session.id, {
      ...(params.lines === undefined ? {} : { lines: params.lines as number }),
      ...(params.before === undefined ? {} : { before: params.before as string }),
      ...(params.format === undefined ? {} : { format: params.format as 'text' | 'ansi' })
    })
  }

  /** Running PTY sessions joined to their layout tab title and worktree display name. */
  sessions = async (): Promise<{
    sessions: (PtySessionInfo & {
      worktreeId: string | null
      workspace: string
      tabTitle: string | null
      worktreeName: string | null
    })[]
  }> => {
    const [allSessions, records] = await Promise.all([
      this.context.pty.list(),
      this.context.call('quirky.session/list', {}) as Promise<Session[]>
    ])
    const running = allSessions.filter((info) => info.state === 'running')
    const worktrees = new Map(records.map((record) => [record.id, record.worktreeId]))
    const worktreeIds = new Set<string>()
    for (const info of running) {
      const worktreeId = worktrees.get(info.sessionId)
      if (worktreeId && worktreeId !== FLOATING_WORKSPACE) worktreeIds.add(worktreeId)
    }

    const worktreeNames = new Map<string, string>()
    const resolveWorktreeNames = Promise.all([...worktreeIds].map(async (worktreeId) => {
      try {
        const worktree = await this.context.call('quirky.worktree/resolve', { selector: `id:${worktreeId}` }) as { name: string }
        worktreeNames.set(worktreeId, worktree.name)
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== RpcErrorCode.NotFound) throw error
      }
    }))
    const [tabTitles] = await Promise.all([
      this.tabTitlesForSessions(running.map((info) => info.sessionId)),
      resolveWorktreeNames
    ])

    return {
      sessions: running.map((info) => {
        const worktreeId = worktrees.get(info.sessionId) ?? null
        return {
          ...info,
          worktreeId,
          workspace: workspaceLabel(info.cwd),
          tabTitle: tabTitles.get(info.sessionId) ?? null,
          worktreeName: worktreeId === null || worktreeId === FLOATING_WORKSPACE
            ? null
            : worktreeNames.get(worktreeId) ?? null
        }
      })
    }
  }

  kill = async (params: Record<string, unknown>): Promise<{ ok: true }> => {
    const session = await this.requireTerminal(params.session as string)
    await this.killSession(session.id)
    return { ok: true }
  }

  /**
   * Force-quits every running session and waits for the host to report them ended. A session
   * still running when the wait runs out is counted as remaining.
   */
  killAll = async (): Promise<{ killedCount: number; remainingCount: number; killedSessionIds: string[] }> => {
    const targets = (await this.context.pty.list()).filter((info) => info.state === 'running').map((info) => info.sessionId)
    await Promise.all(targets.map((id) => this.killSession(id).catch((error) => this.context.log(`could not kill ${id}: ${messageOf(error)}`))))
    let remaining = targets
    for (let poll = 0; poll < KILL_POLLS && remaining.length > 0; poll++) {
      await new Promise((resolve) => setTimeout(resolve, killPollMs()))
      const running = new Set((await this.context.pty.list()).filter((info) => info.state === 'running').map((info) => info.sessionId))
      remaining = targets.filter((id) => running.has(id))
    }
    const killedSessionIds = targets.filter((id) => !remaining.includes(id))
    return { killedCount: killedSessionIds.length, remainingCount: remaining.length, killedSessionIds }
  }

  restartHost = (): Promise<{ pid: number }> => this.context.pty.restartHost()
  mobileState = (params: Record<string, unknown>, caller: PluginCaller) => this.mobile.mobileState(params, caller)

  takeBack = (params: Record<string, unknown>, caller: PluginCaller) => this.mobile.takeBack(params, caller)

  restoreFit = (params: Record<string, unknown>, caller: PluginCaller) => this.mobile.restoreFit(params, caller)

  claim = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireWritable(params.session as string)
    return this.enqueue(session.id, () => this.mobile.claim(session.id, params.cols as number, params.rows as number, caller))
  }

  assertCanInput(sessionId: string, caller: PluginCaller): void {
    this.mobile.assertCanInput(sessionId, caller)
  }

  onData = (sessionId: string, bytes: Uint8Array): void => {
    const tap = this.taps.get(sessionId)
    if (tap) pushTap(tap, bytes)
    const hold = this.holds.get(sessionId)
    if (hold) {
      pushTap(hold, bytes)
      return
    }
    const known = this.received.get(sessionId)
    if (known !== undefined) this.received.set(sessionId, known + bytes.length)
    const mobileHold = this.mobileHolds.get(sessionId)
    if (mobileHold) {
      pushTap(mobileHold, bytes)
      for (const attachment of this.bySession.get(sessionId) ?? []) {
        if (!attachment.mobile) attachment.stream.send(bytes)
      }
      return
    }
    for (const attachment of this.bySession.get(sessionId) ?? []) attachment.stream.send(bytes)
  }

  /** Clears leases and pending/active streams when a session record is removed. */
  onEvent = (event: { type: string }): void => {
    if (event.type !== 'quirky.session/removed') return
    const { sessionId } = (event as PluginEvent).data as { sessionId: string }
    const attachments = this.bySession.get(sessionId)
    const silent = this.silent.get(sessionId)
    const pending = this.pendingBySession.get(sessionId)
    if ((attachments?.size ?? 0) > 0 || (silent?.size ?? 0) > 0 || (pending?.size ?? 0) > 0 || (this.attaching.get(sessionId) ?? 0) > 0) this.forgotten.add(sessionId)
    this.cancelResyncWaitersForSession(sessionId)
    this.clearResyncReservationsForSession(sessionId)
    this.clearMobileRecovery(sessionId, true)
    this.mobile.sessionRemoved(sessionId)
    if (attachments) for (const attachment of [...attachments]) attachment.stream.close()
    if (silent) for (const attachment of [...silent]) attachment.stream.close()
    if (pending) for (const attachment of [...pending]) attachment.stream.close()
  }

  /** Clears phone leases and streams on PTY exit; desktop panes retain their read-only attachment. */
  onExit = (sessionId: string): void => {
    this.clearMobileRecovery(sessionId, true)
    this.mobile.sessionExited(sessionId)
    const attachments = this.bySession.get(sessionId)
    const silent = this.silent.get(sessionId)
    const pending = this.pendingBySession.get(sessionId)
    if (attachments) for (const attachment of [...attachments]) if (attachment.mobile) attachment.stream.close()
    if (silent) for (const attachment of [...silent]) if (attachment.mobile) attachment.stream.close()
    if (pending) for (const attachment of [...pending]) if (attachment.mobile) attachment.stream.close()
  }

  /** Re-subscribes every streamed session and recovers gaps that no longer fit in the host replay buffer. */
  onReconnect = async (): Promise<void> => {
    if (this.closed) return
    for (const [sessionId] of [...this.bySession]) {
      await this.enqueue(sessionId, async () => {
        if (this.closed) return
        const attachments = this.bySession.get(sessionId)
        if (!attachments?.size) return
        const had = this.received.get(sessionId) ?? 0
        const hold: Tap = { chunks: [], buffered: 0, total: 0, overflow: false }
        this.holds.set(sessionId, hold)
        let recoverMobile = false
        try {
          const { replay, offset } = await this.context.pty.subscribe(sessionId, { mode: 'raw' })
          if (this.closed) return
          const bytes = base64ToBytes(replay)
          const missed = offset - had
          this.received.set(sessionId, offset + hold.total)
          if (hold.overflow || missed < 0 || missed > bytes.length) {
            for (const attachment of [...(this.bySession.get(sessionId) ?? [])]) {
              if (!attachment.mobile) this.lagAttachment(attachment)
            }
            recoverMobile = [...(this.bySession.get(sessionId) ?? [])].some((attachment) => attachment.mobile)
          } else {
            if (missed > 0) this.sendAll(attachments, bytes.subarray(bytes.length - missed))
            for (const chunk of hold.chunks) this.sendAll(attachments, chunk)
          }
        } catch (error) {
          if (!this.closed) this.context.log(`could not resume terminal output of ${sessionId}: ${messageOf(error)}`)
        } finally {
          if (this.holds.get(sessionId) === hold) this.holds.delete(sessionId)
        }
        if (recoverMobile) this.recoverMobileSession(sessionId)
      })
    }
  }

  /** Ends every stream and drops the host subscriptions; attaches still in flight are closed when they finish, and new ones are refused. */
  shutdown(): void {
    this.closed = true
    for (const waiter of [...this.resyncWaiters]) waiter.cancel(waiter.closedError)
    this.resyncAt.clear()
    for (const sessionId of new Set([
      ...this.mobileHolds.keys(),
      ...this.mobileRecoveryAt.keys(),
      ...this.mobileRecoveryTimers.keys(),
      ...this.mobileRecoveryQueued.keys(),
      ...this.mobileRecoveryPending
    ])) this.clearMobileRecovery(sessionId, true)
    this.holds.clear()
    this.taps.clear()
    this.mobile.shutdown()
    for (const attachments of [...this.bySession.values(), ...this.silent.values()]) {
      for (const attachment of [...attachments]) attachment.stream.close()
    }
  }

  private refuseWhenClosed(): void {
    if (this.closed) throw this.context.error('conflict', 'quirky.terminal is shut down')
  }

  private sendAll(attachments: Iterable<Attachment>, bytes: Uint8Array): void {
    for (const attachment of attachments) attachment.stream.send(bytes)
  }

  private waitForResyncSlot(
    connection: CallerConnection,
    sessionId: string,
    streamId: number,
    delay: number
  ): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const closedError = this.context.error('conflict', 'terminal connection closed while resyncing')
    let timer: ReturnType<typeof setTimeout>
    let removeClose = () => {}
    let settled = false
    let waiter: ResyncWaiter
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeClose()
      this.resyncWaiters.delete(waiter)
      if (error) reject(error)
      else resolve()
    }
    waiter = {
      connectionId: connection.id,
      sessionId,
      streamId,
      closedError,
      cancel: (error) => finish(error)
    }
    this.resyncWaiters.add(waiter)
    timer = setTimeout(() => finish(), delay)
    removeClose = connection.onClose(() => {
      finish(waiter.closedError)
      this.clearResyncReservationsForConnection(connection.id)
    })
    return promise
  }

  private cancelResyncWaitersForSession(sessionId: string): void {
    for (const waiter of [...this.resyncWaiters]) {
      if (waiter.sessionId === sessionId) {
        waiter.cancel(this.context.error('not-found', `no such stream: ${waiter.streamId}`))
      }
    }
  }

  private clearResyncReservationsForSession(sessionId: string): void {
    for (const key of this.resyncAt.keys()) {
      if (key.endsWith(`:${sessionId}`)) this.resyncAt.delete(key)
    }
  }

  private clearResyncReservationsForConnection(connectionId: number): void {
    const prefix = `${connectionId}:`
    for (const key of this.resyncAt.keys()) {
      if (key.startsWith(prefix)) this.resyncAt.delete(key)
    }
  }

  private lagAttachment(attachment: Attachment): void {
    if (attachment.mobile) return
    const streamId = attachment.stream.streamId
    if (this.byConnection.get(attachment.connectionId)?.get(streamId) !== attachment) return
    const live = this.bySession.get(attachment.sessionId)
    if (!live?.delete(attachment)) return
    if (live.size === 0) this.bySession.delete(attachment.sessionId)
    const silent = this.silent.get(attachment.sessionId) ?? new Set<Attachment>()
    silent.add(attachment)
    this.silent.set(attachment.sessionId, silent)
    attachment.stream.lag?.()
    this.releaseIfIdle(attachment.sessionId)
  }

  private recoverMobileSession(sessionId: string): void {
    if (this.closed || ![...(this.bySession.get(sessionId) ?? [])].some((attachment) => attachment.mobile)) return
    if (this.mobileHolds.has(sessionId)) {
      this.mobileRecoveryPending.add(sessionId)
      return
    }
    if (this.mobileRecoveryQueued.has(sessionId)) return
    const now = Date.now()
    const last = this.mobileRecoveryAt.get(sessionId)
    if (last !== undefined && now - last < MOBILE_RECOVERY_COOLDOWN_MS) {
      if (!this.mobileRecoveryTimers.has(sessionId)) {
        const timer = setTimeout(() => {
          this.mobileRecoveryTimers.delete(sessionId)
          this.recoverMobileSession(sessionId)
        }, MOBILE_RECOVERY_COOLDOWN_MS - (now - last))
        this.mobileRecoveryTimers.set(sessionId, timer)
      }
      return
    }
    const reservation = Symbol()
    this.mobileRecoveryQueued.set(sessionId, reservation)
    void this.enqueue(sessionId, async () => {
      if (this.mobileRecoveryQueued.get(sessionId) !== reservation) return
      this.mobileRecoveryQueued.delete(sessionId)
      if (this.closed || ![...(this.bySession.get(sessionId) ?? [])].some((attachment) => attachment.mobile)) {
        this.mobileRecoveryPending.delete(sessionId)
        return
      }
      this.mobileRecoveryAt.set(sessionId, Date.now())
      await this.runMobileRecovery(sessionId)
    })
  }

  private async runMobileRecovery(sessionId: string): Promise<void> {
    const start = this.received.get(sessionId) ?? 0
    const mobileHold: Tap = { chunks: [], buffered: 0, total: 0, overflow: false }
    this.mobileHolds.set(sessionId, mobileHold)
    try {
      const snap = await this.context.pty.snapshot(sessionId)
      if (this.mobileHolds.get(sessionId) !== mobileHold) return
      const currentEnd = this.received.get(sessionId) ?? (start + mobileHold.total)
      const end = Math.max(currentEnd, snap.offset)
      this.received.set(sessionId, end)
      const after = end - snap.offset
      this.mobileHolds.delete(sessionId)
      const targets = [...(this.bySession.get(sessionId) ?? [])].filter((attachment) => attachment.mobile)
      if (targets.length === 0) {
        if ((this.bySession.get(sessionId)?.size ?? 0) === 0 && (this.attaching.get(sessionId) ?? 0) === 0) {
          this.received.delete(sessionId)
        }
        return
      }
      const resetAndSnap = encoder.encode('\x18\x1b\\\x1bc\x1b[3J' + snap.ansi)
      this.sendAll(targets, resetAndSnap)
      if (after > 0) {
        if (!mobileHold.overflow && after <= mobileHold.buffered) {
          const all = concat(mobileHold.chunks)
          const tail = all.subarray(all.length - after)
          this.sendAll(targets, tail)
        } else {
          this.recoverMobileSession(sessionId)
        }
      }
    } catch (error) {
      if (this.mobileHolds.get(sessionId) === mobileHold) {
        this.mobileHolds.delete(sessionId)
        this.context.log(`could not recover mobile terminal output of ${sessionId}: ${messageOf(error)}`)
        if (!mobileHold.overflow && mobileHold.chunks.length > 0) {
          const targets = [...(this.bySession.get(sessionId) ?? [])].filter((attachment) => attachment.mobile)
          for (const chunk of mobileHold.chunks) this.sendAll(targets, chunk)
        }
      }
    } finally {
      if (this.mobileHolds.get(sessionId) === mobileHold) this.mobileHolds.delete(sessionId)
      if (this.mobileRecoveryPending.delete(sessionId)) this.recoverMobileSession(sessionId)
    }
  }

  private clearMobileRecovery(sessionId: string, clearHold = false): void {
    const timer = this.mobileRecoveryTimers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.mobileRecoveryTimers.delete(sessionId)
    this.mobileRecoveryQueued.delete(sessionId)
    this.mobileRecoveryAt.delete(sessionId)
    this.mobileRecoveryPending.delete(sessionId)
    if (clearHold) this.mobileHolds.delete(sessionId)
  }

  private sessionOf(params: Record<string, unknown>, caller: PluginCaller | undefined): string {
    const explicit = params.session as string | undefined
    const session = explicit ?? (caller === undefined || caller.role === 'plugin' ? undefined : caller.sessionId)
    if (!session) throw this.context.error('invalid-params', 'no session; pass session or call from inside a session')
    return session
  }

  private async requireTerminal(sessionId: string): Promise<Session> {
    const session = (await this.context.call('quirky.session/get', { session: sessionId })) as Session
    if (session.kind !== 'terminal') throw this.context.error('invalid-params', `session ${sessionId} has no terminal`)
    return session
  }

  /** A terminal session that can take input; one that ended says whether `quirky session restore` can bring it back. */
  private async requireWritable(sessionId: string): Promise<Session> {
    const session = await this.requireTerminal(sessionId)
    if (session.status !== 'exited') return session
    throw this.context.error(
      'conflict',
      session.restorable
        ? `session ${session.id} ended when the terminal host stopped; run quirky session restore ${session.id}`
        : `session ${session.id} has exited`
    )
  }

  private async killSession(sessionId: string): Promise<void> {
    await this.context.pty.kill(sessionId, undefined, { reason: 'killed' })
  }

  private input(sessionId: string, bytes: Uint8Array): void {
    this.context.pty.write(sessionId, bytes)
  }

  /** Attaches to the same session run one after another, so each subscribe response is matched with the output that follows it. */
  private enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.attachQueue.get(sessionId) ?? Promise.resolve()).then(work)
    const settled = run.catch(() => {})
    this.attachQueue.set(sessionId, settled)
    void settled.then(() => {
      if (this.attachQueue.get(sessionId) === settled) this.attachQueue.delete(sessionId)
    })
    return run
  }

  private async subscribe(
    attachment: Attachment,
    options: { historyLines: number | undefined; isOpen: () => boolean }
  ) {
    const { sessionId, stream } = attachment
    const { isOpen } = options
    this.attaching.set(sessionId, (this.attaching.get(sessionId) ?? 0) + 1)
    try {
      this.refuseWhenClosed()
      const start = this.received.get(sessionId)
      const tap: Tap = { chunks: [], buffered: 0, total: 0, overflow: false }
      this.taps.set(sessionId, tap)
      let result: PtySubscription
      try {
        result = await this.context.pty.subscribe(sessionId, {
          mode: 'screen',
          ...(options.historyLines === undefined ? {} : { historyLines: options.historyLines })
        })
      } finally {
        this.taps.delete(sessionId)
      }
      const end = start === undefined ? result.offset + tap.total : Math.max(start + tap.total, result.offset)
      const after = end - result.offset
      this.received.set(sessionId, end)
      if (this.closed) {
        stream.close()
        this.refuseWhenClosed()
      }
      if (this.forgotten.has(sessionId)) stream.close()
      if (isOpen()) {
        const streams = this.byConnection.get(attachment.connectionId) ?? new Map()
        streams.set(stream.streamId, attachment)
        this.byConnection.set(attachment.connectionId, streams)
        if (result.live === false) {
          const set = this.silent.get(sessionId) ?? new Set()
          set.add(attachment)
          this.silent.set(sessionId, set)
        } else {
          const set = this.bySession.get(sessionId) ?? new Set()
          set.add(attachment)
          this.bySession.set(sessionId, set)
        }
        if (!attachment.mobile) stream.onLag?.(() => this.lagAttachment(attachment))
        if (result.live !== false && this.bySession.get(sessionId)?.has(attachment) && after > 0) {
          if (tap.overflow || after > tap.buffered) {
            if (attachment.mobile) this.recoverMobileSession(sessionId)
            else this.lagAttachment(attachment)
          } else {
            const all = concat(tap.chunks)
            stream.send(all.subarray(all.length - after))
          }
        }
      }
      const { replay, offset, historyCursor, cols, rows, shellState, live } = result
      return { streamId: stream.streamId, replay, offset, historyCursor, cols, rows, shellState, live }
    } catch (error) {
      throw new Error(messageOf(error))
    } finally {
      const left = (this.attaching.get(sessionId) ?? 1) - 1
      if (left > 0) this.attaching.set(sessionId, left)
      else this.attaching.delete(sessionId)
      if (!isOpen()) this.drop(attachment)
      else this.releaseIfIdle(sessionId)
    }
  }

  private untrackPending(attachment: Attachment): void {
    const pending = this.pendingBySession.get(attachment.sessionId)
    if (!pending) return
    pending.delete(attachment)
    if (pending.size === 0) this.pendingBySession.delete(attachment.sessionId)
  }

  private drop(attachment: Attachment): void {
    this.untrackPending(attachment)
    this.bySession.get(attachment.sessionId)?.delete(attachment)
    const silent = this.silent.get(attachment.sessionId)
    silent?.delete(attachment)
    if (silent?.size === 0) this.silent.delete(attachment.sessionId)
    const streams = this.byConnection.get(attachment.connectionId)
    streams?.delete(attachment.stream.streamId)
    if (streams?.size === 0) {
      this.byConnection.delete(attachment.connectionId)
      this.clearResyncReservationsForConnection(attachment.connectionId)
    }
    this.releaseIfIdle(attachment.sessionId)
    if (attachment.mobile && !attachment.resyncing) {
      this.mobile.detach(attachment.sessionId, attachment.connectionId)
      if (![...(this.bySession.get(attachment.sessionId) ?? [])].some((current) => current.mobile)) {
        this.clearMobileRecovery(attachment.sessionId)
      }
    }
  }

  private releaseIfIdle(sessionId: string): void {
    if ((this.bySession.get(sessionId)?.size ?? 0) > 0) return
    if ((this.attaching.get(sessionId) ?? 0) > 0) return
    const subscribed = this.received.has(sessionId)
    this.received.delete(sessionId)
    if (this.forgotten.delete(sessionId) || !subscribed) return
    this.context.pty.unsubscribe(sessionId).catch(() => {})
  }
}

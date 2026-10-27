import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, type QuirkyEvent, type Session, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { readRuntime, rpcUrl } from '@quirky/protocol/node'
import { cliJson, startOf, startStatusE2E, waitFor, type StatusE2E } from '../../../quirky.agent-status/test/e2e/support'
import { FakeWindow, WORKTREE_VIEW, type Decided, type NotifyEvent, type Status } from '../support'

export { cliJson, waitFor, WORKTREE_VIEW }
export type { Decided, NotifyEvent, Status }

export type Delivery = { delivered: boolean; reason: string }

export type NotificationsOptions = {
  /** `QUIRKY_DESKTOP_AWAY_MS` of the daemon. */
  awayMs?: number
  /** `QUIRKY_NOTIFICATION_COOLDOWN_MS` of the daemon. */
  cooldownMs?: number
}

export type AgentSession = Session & { pid: number }

/**
 * A real daemon on temporary homes with the notifications plugin, an event-subscribed client, a
 * window client, and recorders standing in for the sound player and the OS notifier.
 */
export type NotificationsE2E = {
  e2e: StatusE2E
  /** Every event the daemon has sent the subscribed client, in order. */
  events: QuirkyEvent[]
  /** A client connected with role `ui`, the way the window connects. */
  readonly win: FakeWindow
  /** A temporary directory for the test's own files. */
  scratch: string
  json<T>(args: string[]): Promise<T>
  /** A daemon API call on a client that `reconnect` replaces, so it survives a daemon restart. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  setting(name: string, value: unknown): Promise<void>
  /** Creates a worktree of the fixture repo. */
  worktree(name: string): Promise<Worktree>
  /** The repo's primary worktree. */
  main(): Promise<Worktree>
  /** A plain shell session in `worktree`. */
  shell(worktree: Worktree): Promise<Session>
  /** A claude session in `worktree` with its fake agent running. */
  claude(worktree: Worktree): Promise<AgentSession>
  /** Posts a claude turn through the hook shim: the prompt, then Stop with `message`. */
  finish(session: AgentSession, message?: string): Promise<void>
  /** Resolves with the first `decided` event matching `match` that arrived at or after index `from` of `events`. */
  decision(match: { sessionId?: string; source?: string }, from: number, timeoutMs?: number): Promise<Decided>
  notifies(from?: number): NotifyEvent[]
  /** The `<file> <volume>` lines the sound-player recorder has logged. */
  played(): string[]
  /** The AppleScript texts the OS-notifier recorder has logged, one per banner. */
  osBanners(): string[]
  status(): Promise<Status>
  sessionRecord(id: string): Promise<Session>
  worktreeRecord(id: string): Promise<Worktree>
  /** Clears every marker and the window, so the next test starts from a badge of 0. */
  reset(): Promise<void>
  /** Opens the event and window clients again, after the daemon restarted. */
  reconnect(): Promise<void>
  cleanup(): Promise<void>
}

const SEPARATOR = '\u001e'

export async function startNotificationsE2E(options: NotificationsOptions = {}): Promise<NotificationsE2E> {
  const scratch = realpathSync(mkdtempSync('/tmp/qn-e2e-'))
  const soundLog = join(scratch, 'played.log')
  const osLog = join(scratch, 'banners.log')
  const player = join(scratch, 'player.sh')
  writeFileSync(player, `#!/bin/sh\necho "$1 $2" >> ${JSON.stringify(soundLog)}\n`)
  chmodSync(player, 0o755)

  let e2e: StatusE2E
  try {
    e2e = await startStatusE2E({
      fakes: { claude: true },
      extraEnv: {
        QUIRKY_SOUND_PLAYER: player,
        ...(options.awayMs === undefined ? {} : { QUIRKY_DESKTOP_AWAY_MS: String(options.awayMs) }),
        ...(options.cooldownMs === undefined ? {} : { QUIRKY_NOTIFICATION_COOLDOWN_MS: String(options.cooldownMs) })
      }
    })
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }

  // first on the daemon's PATH, so the no-desktop fallback never reaches the real osascript
  const osascript = join(e2e.fakebin, 'osascript')
  writeFileSync(osascript, `#!/bin/sh\nprintf '%s${SEPARATOR}' "$2" >> ${JSON.stringify(osLog)}\n`)
  chmodSync(osascript, 0o755)

  const events: QuirkyEvent[] = []
  let eventsClient: QuirkyClient | undefined
  let windowClient: QuirkyClient | undefined
  let win: FakeWindow | undefined

  const connect = async () => {
    const url = rpcUrl(readRuntime(e2e.home)!)
    eventsClient?.close()
    windowClient?.close()
    eventsClient = await QuirkyClient.connect(url, { role: 'cli', name: 'events' })
    eventsClient.onEvent((event) => events.push(event))
    await eventsClient.call('events.subscribe', {})
    windowClient = await QuirkyClient.connect(url, { role: 'ui', name: 'window' })
    win = new FakeWindow(windowClient)
  }

  const run: NotificationsE2E = {
    e2e,
    events,
    get win() {
      return win!
    },
    scratch,
    json: (args) => cliJson(e2e, args),
    call: (method, params = {}) => eventsClient!.callAny(method, params),
    async setting(name, value) {
      const result = await e2e.cli(['setting', 'set', `setting:quirky.notifications/${name}`, JSON.stringify(value)])
      if (result.code !== 0) throw new Error(`setting set ${name} failed: ${result.stderr || result.stdout}`)
    },
    async worktree(name) {
      const created = await cliJson<WorktreeCreateResult>(e2e, ['wt', 'create', name])
      return created.worktree
    },
    async main() {
      const all = await cliJson<Worktree[]>(e2e, ['wt', 'list'])
      return all.find((worktree) => worktree.isMain)!
    },
    shell: (worktree) => cliJson<Session>(e2e, ['session', 'new', '--agent', 'shell', '--worktree', `id:${worktree.id}`]),
    async claude(worktree) {
      const session = await cliJson<Session>(e2e, ['session', 'new', '--agent', 'claude', '--worktree', `id:${worktree.id}`])
      const started = await startOf(e2e, 'claude', session.id)
      return { ...session, pid: started.pid }
    },
    async finish(session, message) {
      const payload = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })
      await e2e.shim('claude', session.id, payload('UserPromptSubmit', { prompt: 'go' }), { pid: session.pid })
      await waitFor(
        async () => (await cliJson<{ state: string } | null>(e2e, ['agent-status', 'get', session.id]))?.state === 'working',
        10_000,
        'a working row'
      )
      await e2e.shim('claude', session.id, payload('Stop', message === undefined ? {} : { last_assistant_message: message }), {
        pid: session.pid
      })
    },
    decision(match, from, timeoutMs = 10_000) {
      return waitFor(
        () => {
          for (const event of events.slice(from)) {
            if (event.type !== 'quirky.notifications/decided') continue
            const data = (event as { data: Decided }).data
            if (match.sessionId !== undefined && data.sessionId !== match.sessionId) continue
            if (match.source !== undefined && data.source !== match.source) continue
            return data
          }
          return undefined
        },
        timeoutMs,
        `a decision for ${JSON.stringify(match)}`
      )
    },
    notifies: (from = 0) => events.slice(from).filter((event): event is NotifyEvent => event.type === 'notify'),
    played: () => (existsSync(soundLog) ? readFileSync(soundLog, 'utf8').split('\n').filter(Boolean) : []),
    osBanners: () => (existsSync(osLog) ? readFileSync(osLog, 'utf8').split(SEPARATOR).filter(Boolean) : []),
    status: () => cliJson<Status>(e2e, ['notifications', 'status']),
    sessionRecord: (id) => cliJson<Session>(e2e, ['session', 'get', id]),
    worktreeRecord: (id) => cliJson<Worktree>(e2e, ['wt', 'show', `id:${id}`]),
    async reset() {
      await win!.close().catch(() => {})
      await win!.blur().catch(() => {})
      const current = await run.status()
      for (const worktree of current.unreadWorktrees) await e2e.cli(['wt', 'set', `id:${worktree.id}`, '--read'])
      for (const session of current.unreadSessions) await run.call('quirky.session/setUnread', { session: session.id, unread: null })
      await waitFor(async () => (await run.status()).unreadSessions.length === 0, 10_000, 'markers to clear')
    },
    reconnect: connect,
    async cleanup() {
      eventsClient?.close()
      windowClient?.close()
      try {
        await e2e.cleanup()
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
  }

  try {
    await connect()
  } catch (error) {
    await run.cleanup()
    throw error
  }
  return run
}

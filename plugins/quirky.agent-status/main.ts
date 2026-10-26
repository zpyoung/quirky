import { Database } from 'bun:sqlite'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LaunchHookInput,
  LaunchPatch,
  PluginContext,
  PluginStore,
  QuirkyEvent,
  Session,
  SessionStatus
} from '@quirky/protocol'

const NOTIFICATIONS_SETTING = 'setting:quirky.agent-status/notifications'

const CLAUDE_EVENT_STATUS: Record<string, SessionStatus> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  Notification: 'waiting',
  Stop: 'done'
}

/**
 * The session status an agent hook payload implies, or null when the payload says nothing about
 * status. Codex's notify call fires when a turn finishes.
 */
export function statusForHook(agent: string, payload: unknown): SessionStatus | null {
  if (agent === 'codex') return 'done'
  if (agent === 'claude' && payload && typeof payload === 'object') {
    const event = (payload as { hook_event_name?: unknown }).hook_event_name
    if (typeof event === 'string') return CLAUDE_EVENT_STATUS[event] ?? null
  }
  return null
}

/**
 * True for Claude's idle reminder ("Claude is waiting for your input"), which fires some time after
 * a turn ends and is not a request for the user to act on. Permission and elicitation
 * notifications are not idle reminders.
 */
export function isClaudeIdleNotification(agent: string, payload: unknown): boolean {
  if (agent !== 'claude' || !payload || typeof payload !== 'object') return false
  const { hook_event_name: event, notification_type: type, message } = payload as Record<string, unknown>
  if (event !== 'Notification') return false
  if (typeof type === 'string') return type === 'idle_prompt'
  return typeof message === 'string' && /waiting for your input/i.test(message)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** The Claude settings whose hooks run `<home>/bin/quirky-hook claude` for the events that drive status. */
export function claudeSettings(home: string): unknown {
  const command = `${shellQuote(join(home, 'bin', 'quirky-hook'))} claude`
  const entry = (matcher?: string) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command }]
  })
  return {
    hooks: {
      UserPromptSubmit: [entry()],
      PreToolUse: [entry('*')],
      Notification: [entry()],
      Stop: [entry()]
    }
  }
}

/** Creates the tables and stages v1's `notifications` value for `importNotificationsSetting`. */
function firstMigration(home: string): (store: PluginStore) => void {
  return (store) => {
    store.exec(`
      CREATE TABLE hooks (session_id TEXT PRIMARY KEY, last_hook_at INTEGER NOT NULL);
      CREATE TABLE pending_setting (value TEXT NOT NULL);
    `)
    const v1 = readV1Notifications(home)
    if (v1 !== null) store.run('INSERT INTO pending_setting (value) VALUES (?)', v1)
  }
}

/** The raw JSON of v1's `notifications` setting, or null when the v1 database or row is absent. */
function readV1Notifications(home: string): string | null {
  const path = join(home, 'quirky.db')
  if (!existsSync(path)) return null
  let db: Database | null = null
  try {
    db = new Database(path, { readonly: true })
    const row = db.query("SELECT value FROM settings WHERE key = 'notifications'").get() as { value: string } | null
    return row?.value ?? null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/** Carries v1's `notifications` value into the setting once; a value that is not a boolean is skipped. */
async function importNotificationsSetting(context: PluginContext, store: PluginStore): Promise<void> {
  const pending = store.get<{ value: string }>('SELECT value FROM pending_setting')
  if (!pending) return
  try {
    const value: unknown = JSON.parse(pending.value)
    if (typeof value !== 'boolean') {
      context.log(`skipped v1 notifications setting: ${pending.value} is not a boolean`)
    } else {
      const current = (await context.call('setting.get', { id: NOTIFICATIONS_SETTING })) as { stored?: unknown }
      if (current.stored === undefined) await context.call('setting.set', { id: NOTIFICATIONS_SETTING, value })
    }
  } catch (error) {
    context.log(`v1 notifications setting not imported: ${(error as Error).message}`)
    return
  }
  store.run('DELETE FROM pending_setting')
}

/** Activates the plugin: writes the Claude settings file, then serves hook-driven status and notifications. */
export async function activate(context: PluginContext): Promise<void> {
  const { home } = context
  const store = context.openStore([firstMigration(home)])
  const settingsFile = join(context.dataDir, 'claude-settings.json')
  writeFileSync(settingsFile, JSON.stringify(claudeSettings(home), null, 2))

  context.provide('launch-hook:quirky.agent-status/agent-hooks', (launch: LaunchHookInput): LaunchPatch => {
    if (launch.agent === 'claude') return { args: ['--settings', settingsFile] }
    if (launch.agent === 'codex') {
      const notify = `notify=${JSON.stringify([join(home, 'bin', 'quirky-hook'), 'codex'])}`
      return { args: ['-c', notify] }
    }
    return {}
  })

  context.provide('method:quirky.agent-status/list', async (params: Record<string, unknown>) => {
    const worktree = typeof params.worktree === 'string' ? { worktree: params.worktree } : {}
    const sessions = (await context.call('quirky.session/list', worktree)) as Session[]
    const lastHookAt = new Map(
      store.all<{ session_id: string; last_hook_at: number }>('SELECT session_id, last_hook_at FROM hooks').map(
        (row) => [row.session_id, row.last_hook_at]
      )
    )
    return sessions
      .filter((session) => lastHookAt.has(session.id))
      .map((session) => ({
        sessionId: session.id,
        agent: session.agent,
        status: session.status,
        lastHookAt: lastHookAt.get(session.id)!
      }))
  })

  async function findSession(sessionId: string): Promise<Session | null> {
    try {
      return (await context.call('quirky.session/get', { session: sessionId })) as Session
    } catch {
      return null
    }
  }

  async function notifyFinished(session: Session, status: 'done' | 'waiting'): Promise<void> {
    let title = session.title
    try {
      const worktree = (await context.call('quirky.worktree/resolve', { selector: `id:${session.worktreeId}` })) as {
        name: string
      }
      title = worktree.name
    } catch {
      // the worktree may be gone; the session title still says what finished
    }
    context.notify({
      title,
      body: status === 'done' ? `${session.title} finished` : `${session.title} needs input`,
      sessionId: session.id,
      worktreeId: session.worktreeId,
      open: { view: 'view:quirky.session/worktree', input: { worktree: session.worktreeId, session: session.id } },
      desktop: context.getSetting('notifications') !== false
    })
  }

  async function handleHook(agent: string, sessionId: string, payload: unknown): Promise<void> {
    const session = await findSession(sessionId)
    if (!session) return
    store.run(
      'INSERT INTO hooks (session_id, last_hook_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_hook_at = excluded.last_hook_at',
      sessionId,
      Date.now()
    )
    if (session.status === 'exited' || session.kind !== 'terminal') return
    if (session.status === 'done' && isClaudeIdleNotification(agent, payload)) return
    const status = statusForHook(agent, payload)
    if (!status) return
    await context.call('quirky.session/setStatus', { session: sessionId, status })
    if (status !== session.status && (status === 'done' || status === 'waiting')) await notifyFinished(session, status)
  }

  // hooks are handled one at a time so a repeated Stop sees the status the first one set
  let queue: Promise<void> = Promise.resolve()
  context.subscribe((event: QuirkyEvent) => {
    if (event.type === 'hook.received') {
      queue = queue
        .then(() => handleHook(event.agent, event.sessionId, event.payload))
        .catch((error: Error) => context.log(`hook for ${event.sessionId} failed: ${error.message}`))
    } else if (event.type === 'quirky.session/removed') {
      const { sessionId } = event.data as { sessionId: string }
      store.run('DELETE FROM hooks WHERE session_id = ?', sessionId)
    }
  })

  await importNotificationsSetting(context, store)
}

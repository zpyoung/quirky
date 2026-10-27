import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { CodexHistoryError } from './codex-history'

export type SessionView = {
  id: string
  kind: string
  agent: string
  worktreeId: string
  cwd: string
  status: string
  providerSession: { id: string; transcriptPath: string | null } | null
  resumedFrom: string | null
}

export type RestartOutcome = {
  sessionId: string
  resumedSessionId: string | null
  error: string | null
}

export function sessionBusy(session: SessionView): boolean {
  return session.status === 'starting' || session.status === 'running' || session.status === 'working'
}

export async function readSession(context: PluginContext, sessionId: string): Promise<SessionView | null> {
  try {
    return parseSession(await context.call('quirky.session/get', { session: sessionId }))
  } catch {
    return null
  }
}

export async function sessionIsAlive(context: PluginContext, sessionId: string): Promise<boolean | null> {
  try {
    const sessions = await context.pty.list()
    return sessions.some((session) => session.sessionId === sessionId && session.alive)
  } catch {
    return null
  }
}

export async function restartSession(
  context: PluginContext,
  sessionId: string,
  provider: ManagedProvider,
  options?: { preflightResume?: (old: SessionView) => Promise<void> }
): Promise<RestartOutcome> {
  const old = await readSession(context, sessionId)
  if (!old || old.kind !== 'terminal' || old.agent !== provider || !old.providerSession?.id) {
    return failed(sessionId)
  }
  if (!isAbsolute(old.cwd) || !existsSync(old.cwd) || /[\u0000-\u001f\u007f]/.test(old.providerSession.id)) {
    return failed(sessionId)
  }
  try {
    const rawAgent = await context.call('quirky.agents/get', { agent: old.agent })
    if (!isRecord(rawAgent) || rawAgent.resumable !== true) return failed(sessionId)
  } catch {
    return failed(sessionId)
  }

  const alive = await sessionIsAlive(context, sessionId)
  if (alive === null) return failed(sessionId)

  if (options?.preflightResume) {
    try {
      await options.preflightResume(old)
    } catch (error) {
      return {
        sessionId,
        resumedSessionId: null,
        error: error instanceof CodexHistoryError
          ? error.message
          : 'Codex conversation preparation failed before the old process was stopped. Verify the source rollout and selected account, then retry.'
      }
    }
  }

  if (alive) {
    try {
      await killAndWait(context, sessionId)
    } catch {
      return failed(sessionId)
    }
  }

  let resumed: SessionView | null = null
  try {
    resumed = parseSession(await context.call('quirky.session/resume', { session: sessionId }))
  } catch {
    return provider === 'codex'
      ? failedCodexResume(sessionId)
      : failed(sessionId)
  }
  if (!resumed) resumed = await findResumedSession(context, sessionId)
  if (
    !resumed ||
    resumed.resumedFrom !== old.id ||
    resumed.cwd !== old.cwd ||
    resumed.providerSession?.id !== old.providerSession.id
  ) return provider === 'codex' ? failedCodexResume(sessionId) : failed(sessionId)

  try {
    await context.call('quirky.session/close', { session: sessionId })
  } catch {
    return { sessionId, resumedSessionId: resumed.id, error: 'The old session record could not be closed; retry cleanup from the session list.' }
  }

  try {
    await context.call('quirky.terminal/workspace', { workspace: resumed.worktreeId, ensure: true })
    await context.call('quirky.terminal/focusPane', { workspace: resumed.worktreeId, session: resumed.id })
  } catch {
    return { sessionId, resumedSessionId: resumed.id, error: 'The resumed session is running, but its terminal could not be focused.' }
  }
  return { sessionId, resumedSessionId: resumed.id, error: null }
}

async function findResumedSession(context: PluginContext, previousId: string): Promise<SessionView | null> {
  try {
    const value: unknown = await context.call('quirky.session/list', {})
    if (!Array.isArray(value)) return null
    for (const item of value) {
      const session = parseSession(item)
      if (session && isRecord(item) && item.resumedFrom === previousId) return session
    }
  } catch {
    return null
  }
  return null
}

async function killAndWait(context: PluginContext, sessionId: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  let unsubscribe = () => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  const complete = (error?: Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    unsubscribe()
    if (error) reject(error)
    else resolve()
  }
  unsubscribe = context.pty.onExit((exitedId) => {
    if (exitedId === sessionId) complete()
  })
  timeout = setTimeout(() => complete(new Error('PTY did not stop')), 5000)
  try {
    await context.pty.kill(sessionId, undefined, { reason: 'killed' })
    if (await sessionIsAlive(context, sessionId) === false) complete()
  } catch {
    complete(new Error('PTY could not be stopped'))
  }
  await promise
}

function parseSession(value: unknown): SessionView | null {
  if (!isRecord(value)) return null
  const id = nonempty(value.id)
  const kind = nonempty(value.kind)
  const agent = nonempty(value.agent)
  const worktreeId = nonempty(value.worktreeId)
  const cwd = nonempty(value.cwd)
  const status = nonempty(value.status)
  if (!id || !kind || !agent || !worktreeId || !cwd || !status) return null
  let providerSession: SessionView['providerSession'] = null
  if (isRecord(value.providerSession)) {
    const providerId = nonempty(value.providerSession.id)
    if (providerId) {
      providerSession = {
        id: providerId,
        transcriptPath: typeof value.providerSession.transcriptPath === 'string' ? value.providerSession.transcriptPath : null
      }
    }
  }
  return {
    id,
    kind,
    agent,
    worktreeId,
    cwd,
    status,
    providerSession,
    resumedFrom: typeof value.resumedFrom === 'string' ? value.resumedFrom : null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function failed(sessionId: string): RestartOutcome {
  return { sessionId, resumedSessionId: null, error: 'The session cannot be resumed safely. Keep it on the previous account or retry after it becomes available.' }
}

function failedCodexResume(sessionId: string): RestartOutcome {
  return {
    sessionId,
    resumedSessionId: null,
    error: 'Codex resume did not complete; the previous session record was kept. Verify the source rollout and target sessions folder, then retry.'
  }
}

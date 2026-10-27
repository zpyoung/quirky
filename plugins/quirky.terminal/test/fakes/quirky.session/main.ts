import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind, PluginContext, Session } from '@quirky/protocol'

const WORKTREE_PATHS: Record<string, string> = { wt_main: '/fake/alpha', wt_other: '/fake/other' }

/** The file a test writes sessions to before the daemon starts; the fake keeps its sessions there across restarts. */
export function sessionsFile(dataDir: string): string {
  return join(dataDir, 'sessions.json')
}

/**
 * Stands in for the session plugin with the methods and the `removed` event the terminal plugin
 * uses: records are kept in a JSON file, terminals are spawned on the PTY host, and close forgets
 * the terminal before announcing the removal. A PTY exit ends the record, restorable when the host
 * stopped; `restore` starts a shell in such a record.
 */
export function activate(context: PluginContext): void {
  const file = sessionsFile(context.dataDir)
  let sessions: Session[] = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Session[]) : []
  const save = () => writeFileSync(file, JSON.stringify(sessions))

  const find = (id: string) => {
    const session = sessions.find((s) => s.id === id)
    if (!session) throw context.error('not-found', `no such session: ${id}`)
    return session
  }

  const record = (params: Record<string, unknown>, kind: Session['kind'], title: string): Session => {
    const worktreeId = String(params.worktree ?? 'id:wt_main').replace(/^id:/, '')
    const cwd = WORKTREE_PATHS[worktreeId]
    if (!cwd) throw context.error('not-found', `no worktree matches ${String(params.worktree)}`)
    const now = Date.now()
    return {
      id: `s_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      kind,
      agent: params.agent as AgentKind,
      worktreeId,
      cwd,
      title,
      status: 'running',
      createdAt: now,
      lastActivityAt: now,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false
    }
  }

  context.provide('method:quirky.session/get', (params: Record<string, unknown>) => find(params.session as string))
  context.provide('method:quirky.session/list', () => sessions)
  context.provide('method:quirky.session/create', async (params: Record<string, unknown>) => {
    const session = record(params, 'terminal', params.agent === 'shell' ? 'Shell' : String(params.agent))
    await context.pty.spawn(session.id, { argv: ['/bin/zsh', '-l'], cwd: session.cwd, env: {}, cols: 80, rows: 24 })
    sessions.push(session)
    save()
    return session
  })
  context.provide('method:quirky.session/register', (params: Record<string, unknown>) => {
    const session = record(params, 'structured', params.title as string)
    sessions.push(session)
    save()
    return session
  })
  context.provide('method:quirky.session/restore', async (params: Record<string, unknown>) => {
    const session = find(params.session as string)
    if (session.status !== 'exited') return session
    if (!session.restorable) throw context.error('conflict', `session ${session.id} can't be restored`)
    await context.pty.spawn(session.id, { argv: ['/bin/zsh', '-l'], cwd: session.cwd, env: {}, cols: 80, rows: 24, restore: true })
    Object.assign(session, { status: 'running', agent: 'shell', exitCode: null, exitSignal: null, exitCause: null, restorable: false })
    save()
    return session
  })
  context.pty.onExit((sessionId, exitCode, exit) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session || session.status === 'exited') return
    const restorable = exit.exitCause === 'host-restart' || exit.exitCause === 'host-lost'
    Object.assign(session, { status: 'exited', exitCode, exitSignal: exit.exitSignal, exitCause: exit.exitCause, restorable })
    save()
  })
  context.provide('method:quirky.session/close', async (params: Record<string, unknown>) => {
    const session = find(params.session as string)
    if (session.kind === 'terminal') await context.pty.forget(session.id)
    sessions = sessions.filter((s) => s.id !== session.id)
    save()
    context.emit('removed', { sessionId: session.id })
    return { ok: true }
  })
}

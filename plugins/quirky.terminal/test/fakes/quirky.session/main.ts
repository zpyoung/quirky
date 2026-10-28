import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AgentKind, PluginContext, Session } from '@quirky/protocol'

declare global {
  var __FAKE_SESSION_CREATES__: Record<string, unknown>[] | undefined
}

/** The params of every `create` the fake received, oldest first; the daemon runs in the test process, so the global is shared. */
export function sessionCreates(): Record<string, unknown>[] {
  globalThis.__FAKE_SESSION_CREATES__ ??= []
  return globalThis.__FAKE_SESSION_CREATES__
}

/** The file a test writes sessions to before the daemon starts; the fake keeps its sessions there across restarts. */
export function sessionsFile(dataDir: string): string {
  return join(dataDir, 'sessions.json')
}

/**
 * Stands in for the session plugin with the methods and events the terminal plugin uses. Records
 * are kept in a JSON file, terminals are spawned on the PTY host, and `create` accepts `cwd`,
 * `agent`, `prompt`, `title`, `model`, `options`, `extraArgs` and the synthetic `floating` worktree.
 * Every change announces `changed` or `removed`. A PTY exit ends the record, restorable when the
 * host stopped; `restore` starts a shell in such a record.
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

  const target = async (selector: unknown, cwd?: string): Promise<{ id: string; path: string }> => {
    if (selector === 'floating') return { id: 'floating', path: cwd ?? process.env.HOME ?? '/' }
    const worktree = (await context.call('quirky.worktree/resolve', { selector: String(selector ?? 'id:wt_main') })) as { id: string; path: string }
    return { id: worktree.id, path: worktree.path }
  }

  const titleFor = (worktreeId: string, base: string) => {
    const taken = new Set(sessions.filter((s) => s.worktreeId === worktreeId).map((s) => s.title))
    for (let n = 1; ; n++) {
      const title = n === 1 ? base : `${base} ${n}`
      if (!taken.has(title)) return title
    }
  }

  const record = async (params: Record<string, unknown>, kind: Session['kind'], baseTitle: string): Promise<Session> => {
    const cwd = params.cwd as string | undefined
    if (cwd !== undefined && !(isAbsolute(cwd) && existsSync(cwd) && statSync(cwd).isDirectory())) {
      throw context.error('invalid-params', 'cwd must be an existing directory')
    }
    const where = await target(params.worktree, cwd)
    const now = Date.now()
    return {
      id: `s_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      kind,
      agent: (params.agent ?? 'shell') as AgentKind,
      worktreeId: where.id,
      cwd: cwd ?? where.path,
      title: titleFor(where.id, baseTitle),
      status: 'running',
      createdAt: now,
      lastActivityAt: now,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false
    }
  }

  const announce = (session: Session) => context.emit('changed', { session })

  context.provide('method:quirky.session/get', (params: Record<string, unknown>) => find(params.session as string))
  context.provide('method:quirky.session/list', (params: Record<string, unknown>) =>
    params.worktree === undefined ? sessions : sessions.filter((s) => s.worktreeId === String(params.worktree).replace(/^id:/, ''))
  )
  context.provide('method:quirky.session/create', async (params: Record<string, unknown>) => {
    sessionCreates().push(params)
    if (typeof params.extraArgs === 'string' && params.extraArgs.includes('--refused')) {
      throw context.error('invalid-params', 'extraArgs flag --refused is not allowed')
    }
    const agent = (params.agent ?? 'shell') as string
    const label = agent === 'shell' ? 'Shell' : ((await context.call('quirky.agents/get', { agent })) as { label: string }).label
    const session = await record(params, 'terminal', (params.title as string | undefined) ?? label)
    await context.pty.spawn(session.id, { argv: ['/bin/zsh', '-l'], cwd: session.cwd, env: {}, cols: 80, rows: 24 })
    sessions.push(session)
    save()
    announce(session)
    return session
  })
  context.provide('method:quirky.session/register', async (params: Record<string, unknown>) => {
    const session = await record(params, 'structured', params.title as string)
    sessions.push(session)
    save()
    announce(session)
    return session
  })
  context.provide('method:quirky.session/restore', async (params: Record<string, unknown>) => {
    const session = find(params.session as string)
    if (session.status !== 'exited') return session
    if (!session.restorable) throw context.error('conflict', `session ${session.id} can't be restored`)
    await context.pty.spawn(session.id, { argv: ['/bin/zsh', '-l'], cwd: session.cwd, env: {}, cols: 80, rows: 24, restore: true })
    Object.assign(session, { status: 'running', agent: 'shell', exitCode: null, exitSignal: null, exitCause: null, restorable: false })
    save()
    announce(session)
    return session
  })
  context.pty.onExit((sessionId, exitCode, exit) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session || session.status === 'exited') return
    const restorable = exit.exitCause === 'host-restart' || exit.exitCause === 'host-lost' || exit.exitCause === 'stopped'
    Object.assign(session, { status: 'exited', exitCode, exitSignal: exit.exitSignal, exitCause: exit.exitCause, restorable })
    save()
    announce(session)
  })
  context.provide('method:quirky.session/close', async (params: Record<string, unknown>) => {
    const session = find(params.session as string)
    if (session.kind === 'terminal') await context.pty.forget(session.id).catch(() => {})
    sessions = sessions.filter((s) => s.id !== session.id)
    save()
    context.emit('removed', { sessionId: session.id })
    return { ok: true }
  })
}

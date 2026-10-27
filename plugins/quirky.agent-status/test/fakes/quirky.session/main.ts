import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatusSummary, PluginContext, Session } from '@quirky/protocol'

type StatusCall = { session: string; status: string; agentStatus?: AgentStatusSummary | null }

/**
 * In-memory stand-in for quirky.session: records every setStatus and setProviderSession call and
 * emits `changed` like the real one. Sessions are kept in the plugin's data directory so a daemon
 * restart on the same home sees them again.
 */
export function activate(context: PluginContext): void {
  const file = join(context.dataDir, 'sessions.json')
  const sessions = new Map<string, Session>(
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Session[]).map((session) => [session.id, session]) : []
  )
  const statusCalls: StatusCall[] = []
  const providerCalls: { session: string; id: string; transcriptPath?: string }[] = []

  const byName = (name: string): Session | undefined => {
    const holders = [...sessions.values()].filter((s) => s.name === name.toLowerCase())
    return holders.find((s) => s.status !== 'exited') ?? holders[0]
  }
  const save = () => writeFileSync(file, JSON.stringify([...sessions.values()]))
  const require = (id: unknown): Session => {
    const session = sessions.get(String(id)) ?? byName(String(id))
    if (!session) throw context.error('not-found', `no session ${id}`)
    return session
  }

  context.provide('method:quirky.session/seed', (params: Record<string, unknown>) => {
    const session = params as unknown as Session
    sessions.set(session.id, session)
    save()
    return session
  })
  context.provide('method:quirky.session/list', (params: Record<string, unknown>) =>
    [...sessions.values()].filter((s) => params.worktree === undefined || s.worktreeId === params.worktree)
  )
  context.provide('method:quirky.session/get', (params: Record<string, unknown>) => require(params.session))
  context.provide('method:quirky.session/setStatus', (params: Record<string, unknown>) => {
    const session = require(params.session)
    statusCalls.push({
      session: session.id,
      status: String(params.status),
      ...(params.agentStatus !== undefined ? { agentStatus: params.agentStatus as AgentStatusSummary | null } : {})
    })
    const updated: Session = {
      ...session,
      status: params.status as Session['status'],
      ...(params.agentStatus !== undefined ? { agentStatus: params.agentStatus as AgentStatusSummary | null } : {}),
      lastActivityAt: Date.now()
    }
    const changed =
      updated.status !== session.status || JSON.stringify(updated.agentStatus ?? null) !== JSON.stringify(session.agentStatus ?? null)
    sessions.set(session.id, updated)
    save()
    if (changed) context.emit('changed', { session: updated })
    return updated
  })
  context.provide('method:quirky.session/setProviderSession', (params: Record<string, unknown>) => {
    const session = require(params.session)
    const transcriptPath = typeof params.transcriptPath === 'string' ? params.transcriptPath : null
    providerCalls.push({
      session: session.id,
      id: String(params.id),
      ...(transcriptPath !== null ? { transcriptPath } : {})
    })
    const updated: Session = { ...session, providerSession: { id: String(params.id), transcriptPath } as Session['providerSession'] }
    sessions.set(session.id, updated)
    save()
    context.emit('changed', { session: updated })
    return updated
  })
  context.provide('method:quirky.session/write', (params: Record<string, unknown>) => {
    context.pty.write(String(params.session), String(params.data))
    return true
  })
  context.provide('method:quirky.session/calls', () => statusCalls)
  context.provide('method:quirky.session/providerCalls', () => providerCalls)
  context.provide('method:quirky.session/create', async (params: Record<string, unknown>) => {
    const worktreeId = String(params.worktree)
    return context.launch.hooks({
      sessionId: 's_new',
      worktreeId,
      repoId: 'r1',
      cwd: '/fake/alpha',
      agent: String(params.agent),
      ...(typeof params.prompt === 'string' ? { prompt: params.prompt } : {})
    })
  })
  context.provide('method:quirky.session/remove', (params: Record<string, unknown>) => {
    sessions.delete(String(params.session))
    save()
    context.emit('removed', { sessionId: params.session })
    return true
  })
}

import { AGENT_KINDS, type AgentKind, type Session } from '@quirky/protocol'
import { UsageError, flagBoolean, flagString } from '../args'
import { formatRecord, formatTable } from '../output'
import { requireFlag, resolveWorktreeId, takePositionals } from './support'
import type { Command } from './types'

const sessionRecord = (session: Session) =>
  formatRecord([
    ['id', session.id],
    ['agent', session.agent],
    ['kind', session.kind],
    ['status', session.status],
    ['worktree', session.worktreeId]
  ])

export const sessionList: Command = {
  name: 'session list',
  usage: 'session list [--worktree <id>]',
  summary: 'list sessions (all worktrees unless filtered)',
  flags: { worktree: 'string' },
  async run(args, ctx) {
    takePositionals(args, [])
    const worktreeId = flagString(args, 'worktree')
    const sessions = await ctx.rpc.call('session.list', worktreeId ? { worktreeId } : {})
    ctx.out.result(sessions, () =>
      sessions.length
        ? formatTable(
            ['ID', 'AGENT', 'KIND', 'STATUS', 'WORKTREE', 'TITLE'],
            sessions.map((s) => [s.id, s.agent, s.kind, s.status, s.worktreeId, s.title])
          )
        : 'no sessions'
    )
  }
}

export const sessionNew: Command = {
  name: 'session new',
  usage: 'session new --agent <kind> [--worktree <id>] [--prompt <text>] [--background]',
  summary: `start a session (${AGENT_KINDS.join(', ')}); --background runs a structured session`,
  flags: { agent: 'string', worktree: 'string', prompt: 'string', background: 'boolean' },
  async run(args, ctx) {
    takePositionals(args, [])
    const agent = requireFlag(args, 'agent')
    if (!AGENT_KINDS.includes(agent as AgentKind)) {
      throw new UsageError(`--agent must be one of ${AGENT_KINDS.join(', ')}`)
    }
    const prompt = flagString(args, 'prompt')
    const background = flagBoolean(args, 'background')
    if (background && !prompt) throw new UsageError('--background requires --prompt')
    const worktreeId = await resolveWorktreeId(args, ctx)
    const session = background
      ? await ctx.rpc.call('session.createStructured', { worktreeId, agent: agent as AgentKind, prompt: prompt as string })
      : await ctx.rpc.call('session.create', {
          worktreeId,
          agent: agent as AgentKind,
          ...(prompt ? { prompt } : {})
        })
    ctx.out.result(session, () => sessionRecord(session))
  }
}

export const sessionClose: Command = {
  name: 'session close',
  usage: 'session close <id>',
  summary: 'close a session and forget it',
  flags: {},
  async run(args, ctx) {
    const [sessionId] = takePositionals(args, ['id'])
    const result = await ctx.rpc.call('session.close', { sessionId })
    ctx.out.result(result, () => `closed ${sessionId}`)
  }
}
